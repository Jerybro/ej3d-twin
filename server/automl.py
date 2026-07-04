"""AutoML 建模引擎 — 對標 Tukey 模型頁（fitting）。

演算法對齊 Tukey 九式（sklearn 實作）；差異化：開放超參數自訂＋自動調參可選
（Tukey 全自動調參、不給使用者手調）。
訓練資料＝資料前處理的現行視圖（steps pipeline 重放後），模型成為歷程下游。
"""
from __future__ import annotations

import io
import json
import threading
import uuid
from datetime import datetime
from pathlib import Path

import numpy as np
import pandas as pd
from fastapi import APIRouter, File, HTTPException, UploadFile
from fastapi.responses import FileResponse

from .dataprep import DATA_DIR, _load_base, _load_steps, apply_steps

router = APIRouter(prefix="/api/automl", tags=["automl"])
AUTOML_DIR = DATA_DIR / "automl"
AUTOML_DIR.mkdir(parents=True, exist_ok=True)

# ------------------------------------------------------ 演算法註冊表
# tasks: regression / classification / timeseries；params schema:
# {key, label, type(int/float/str/choice), default, min, max, choices}
TAB = ["regression", "classification"]
ALGOS = {
    "GLM": {
        "name": "廣義線性迴歸 (GLM)", "tasks": TAB, "params": [],
        "desc": "最基本的線性模型：假設目標與每個變數是直線關係。速度最快、最容易解讀（每個變數一個係數），適合先跑一個當基準線；缺點是抓不到彎曲或變數交互的關係。做分類時等於邏輯斯迴歸。",
    },
    "RIDGE": {
        "name": "脊迴歸 (Ridge)", "tasks": TAB,
        "desc": "線性模型加上「抑制係數過大」的保險（L2 正則化）。變數多、彼此高度相關（共線性）時比 GLM 穩定，不易被雜訊帶偏。",
        "params": [{"key": "alpha", "label": "正則化強度 alpha", "type": "float", "default": 1.0, "min": 0.0001, "max": 1000, "step": 0.1,
                    "desc": "壓抑係數的力道。調大＝模型更保守、更不易過擬合，但太大會什麼都學不到；調小＝更貼訓練資料。常用 0.1–10。"}],
    },
    "LASSO": {
        "name": "套索迴歸 (Lasso)", "tasks": TAB,
        "desc": "線性模型加上「自動篩選變數」的能力（L1 正則化）：不重要的變數係數會被壓到 0 直接淘汰。想知道幾十個變數裡哪幾個才真正重要時特別好用。",
        "params": [{"key": "alpha", "label": "正則化強度 alpha", "type": "float", "default": 0.1, "min": 0.0001, "max": 100, "step": 0.01,
                    "desc": "篩選力道。調大＝淘汰更多變數、模型更精簡；調小＝保留更多變數。常用 0.001–1。"}],
    },
    "HUBER": {
        "name": "穩健迴歸 (Huber)", "tasks": ["regression"],
        "desc": "對離群值不敏感的線性模型：少數量測異常或尖峰不會把整條迴歸線拉歪。資料裡有儀錶飄移、突波時比 GLM 可靠。",
        "params": [
            {"key": "epsilon", "label": "離群閾值 epsilon", "type": "float", "default": 1.35, "min": 1.0, "max": 5.0, "step": 0.05,
             "desc": "誤差多大開始被當離群值降權。調小＝更多點被視為離群、更穩健；調大＝行為趨近一般線性迴歸。預設 1.35 是統計學建議值。"},
            {"key": "alpha", "label": "正則化 alpha", "type": "float", "default": 0.0001, "min": 1e-6, "max": 1.0, "step": 0.0001,
             "desc": "抑制係數過大的保險，通常維持很小即可。"},
        ],
    },
    "PLS": {
        "name": "偏最小平方 (PLS)", "tasks": ["regression"],
        "desc": "先把幾十個彼此相關的變數壓縮成少數「綜合成分」再做迴歸。感測器很多且高度連動（化工製程常見）時特別合適，抗共線性。",
        "params": [{"key": "n_components", "label": "潛在成分數", "type": "int", "default": 4, "min": 1, "max": 20,
                    "desc": "壓縮後保留幾個綜合成分。太少＝丟失資訊；太多＝失去降維意義。常用 2–10，可看驗證分數挑。"}],
    },
    "GNET": {
        "name": "正規化回歸 (GNET)", "tasks": TAB,
        "desc": "Ridge 與 Lasso 的混合體（ElasticNet）：同時抑制係數又篩選變數，兩邊的優點各取一些。變數多又相關、且想順便篩變數時用。",
        "params": [
            {"key": "alpha", "label": "正則化強度 alpha", "type": "float", "default": 1.0, "min": 0.0001, "max": 100, "step": 0.1,
             "desc": "整體正則化力道。調大＝更保守更精簡；調小＝更貼資料。"},
            {"key": "l1_ratio", "label": "L1 比例 l1_ratio", "type": "float", "default": 0.5, "min": 0.0, "max": 1.0, "step": 0.1,
             "desc": "混合比例：1＝純 Lasso（重篩變數）、0＝純 Ridge（重穩定）、0.5＝各半。"},
        ],
    },
    "GAM": {
        "name": "廣義相加模型 (GAM)", "tasks": TAB,
        "desc": "每個變數各自擬合一條平滑曲線再相加：能抓非線性關係，又保留「逐變數解讀」的能力——想看單一變數對目標的彎曲影響時好用。",
        "params": [
            {"key": "n_knots", "label": "樣條節點數 n_knots", "type": "int", "default": 8, "min": 4, "max": 30,
             "desc": "每條曲線的彎折點數。調大＝曲線更彎更貼資料，太大會過擬合；調小＝更平滑保守。常用 5–15。"},
            {"key": "alpha", "label": "Ridge alpha", "type": "float", "default": 1.0, "min": 0.0001, "max": 100, "step": 0.1,
             "desc": "曲線平滑度的保險，調大曲線更平滑。"},
        ],
    },
    "SVM": {
        "name": "支持向量機 (SVM)", "tasks": TAB,
        "desc": "在高維空間裡找「最穩」的分界面或迴歸帶。中小樣本、非線性關係時表現好；樣本數上萬時訓練偏慢。",
        "params": [
            {"key": "C", "label": "懲罰係數 C", "type": "float", "default": 1.0, "min": 0.01, "max": 1000, "step": 0.1,
             "desc": "對訓練誤差的容忍度。調大＝更貼訓練資料（易過擬合）；調小＝更寬容更平滑（易欠擬合）。常用 0.1–100。"},
            {"key": "epsilon", "label": "不敏感帶 epsilon（迴歸）", "type": "float", "default": 0.1, "min": 0.001, "max": 10, "step": 0.05,
             "desc": "迴歸時允許的「免懲罰」誤差帶寬：誤差在帶內不計較。調大＝模型更粗略但更穩。"},
            {"key": "gamma", "label": "核係數 gamma", "type": "choice", "default": "scale", "choices": ["scale", "auto"],
             "desc": "非線性核函數的影響範圍，scale＝依資料自動決定（建議維持）。"},
        ],
    },
    "KNN": {
        "name": "K-鄰近法 (KNN)", "tasks": TAB,
        "desc": "不建公式：預測時直接找歷史資料中「最像」的 k 筆取平均（迴歸）或多數決（分類）。直覺、零假設，但資料量大時預測慢、變數很多時會失準。",
        "params": [
            {"key": "n_neighbors", "label": "鄰居數 k", "type": "int", "default": 5, "min": 1, "max": 50,
             "desc": "參考幾筆最像的歷史資料。調小＝敏感、容易被雜訊騙；調大＝平滑但反應鈍。常用 3–15。"},
            {"key": "weights", "label": "權重", "type": "choice", "default": "uniform", "choices": ["uniform", "distance"],
             "desc": "uniform＝k 筆等權平均；distance＝越像的資料影響越大。"},
        ],
    },
    "DT": {
        "name": "決策樹 (DT)", "tasks": TAB,
        "desc": "一連串「若溫度 > x 則…」的規則樹，人能直接看懂、可畫成流程圖。單棵樹容易過擬合，準確度通常輸給森林/提升法——要解讀性時才選它。",
        "params": [
            {"key": "max_depth", "label": "最大深度（空=不限）", "type": "int", "default": None, "min": 2, "max": 40,
             "desc": "規則巢狀的層數上限。調大＝規則更細、易過擬合；調小＝更粗略但穩。留空＝長到底。"},
            {"key": "min_samples_leaf", "label": "葉最小樣本", "type": "int", "default": 3, "min": 1, "max": 100,
             "desc": "每條末端規則至少要涵蓋幾筆資料。調大＝防止為個別樣本硬造規則（防過擬合）。"},
        ],
    },
    "ET": {
        "name": "極端隨機樹 (ExtraTrees)", "tasks": TAB,
        "desc": "一大群「切割點也隨機」的決策樹投票。比隨機森林更快、隨機性更強、更抗過擬合；個別樹更弱但群體更穩。",
        "params": [
            {"key": "n_estimators", "label": "樹數", "type": "int", "default": 300, "min": 20, "max": 1000,
             "desc": "群體裡有幾棵樹。調大＝更穩但訓練更久，300 以上通常收益遞減。"},
            {"key": "max_depth", "label": "最大深度（空=不限）", "type": "int", "default": None, "min": 2, "max": 40,
             "desc": "單棵樹的深度上限，留空＝不限（靠群體投票抵消過擬合）。"},
        ],
    },
    "ADA": {
        "name": "AdaBoost", "tasks": TAB,
        "desc": "一連串弱模型接力：每一棒都專攻上一棒做錯的樣本，最後加權合議。經典的提升法，對雜訊大的資料比 XGB 敏感。",
        "params": [
            {"key": "n_estimators", "label": "弱學習器數", "type": "int", "default": 100, "min": 10, "max": 500,
             "desc": "接力棒數。調大＝學得更細但更慢、可能過擬合。"},
            {"key": "learning_rate", "label": "學習率", "type": "float", "default": 1.0, "min": 0.01, "max": 3.0, "step": 0.05,
             "desc": "每一棒的話語權。調小＝更穩但需要更多棒配合。"},
        ],
    },
    "XGB": {
        "name": "梯度提升 (XGB)", "tasks": TAB,
        "desc": "一棵接一棵樹，每棵專門修正前面所有樹的殘差。工業表格資料的首選之一，準確度通常在最高梯隊；代價是比線性模型難解讀（看重要變數圖輔助）。",
        "params": [
            {"key": "max_iter", "label": "樹數 n_estimators", "type": "int", "default": 200, "min": 20, "max": 1000,
             "desc": "接力修正的樹數。調大＝學更細但更慢；搭配低學習率效果最穩。"},
            {"key": "learning_rate", "label": "學習率", "type": "float", "default": 0.1, "min": 0.005, "max": 1.0, "step": 0.01,
             "desc": "每棵樹修正的幅度。調小（如 0.03）＝更穩、需更多樹；調大＝學得快但易過擬合。常用 0.03–0.3。"},
            {"key": "max_depth", "label": "最大深度（空=不限）", "type": "int", "default": None, "min": 2, "max": 20,
             "desc": "單棵樹深度。調小（4–8）通常泛化較好，留空＝自動。"},
            {"key": "l2_regularization", "label": "L2 正則化", "type": "float", "default": 0.0, "min": 0.0, "max": 10, "step": 0.1,
             "desc": "抑制過擬合的保險。驗證分數遠低於訓練分數時可調大試試。"},
        ],
    },
    "RF": {
        "name": "隨機森林 (RF)", "tasks": TAB,
        "desc": "幾百棵在隨機子樣本上生長的決策樹投票。穩定、抗過擬合、幾乎不用調參的萬用選擇——不知道選什麼時的安全牌。",
        "params": [
            {"key": "n_estimators", "label": "樹數 n_estimators", "type": "int", "default": 300, "min": 20, "max": 1000,
             "desc": "森林裡的樹數。調大＝更穩但更慢，300 以上收益遞減。"},
            {"key": "max_depth", "label": "最大深度（空=不限）", "type": "int", "default": None, "min": 2, "max": 40,
             "desc": "單棵樹深度上限，留空＝長到底（森林投票會抵消單樹過擬合）。"},
            {"key": "min_samples_leaf", "label": "葉最小樣本", "type": "int", "default": 1, "min": 1, "max": 50,
             "desc": "末端規則的最少樣本數，調大＝更平滑保守。"},
        ],
    },
    "GPR": {
        "name": "高斯過程 (GPR，小樣本)", "tasks": ["regression"],
        "desc": "貝式方法：把預測當成機率分布來估。樣本少（幾十到幾百筆）時能給出平滑擬合；樣本一大就又慢又吃記憶體，僅建議小資料用。",
        "params": [{"key": "alpha", "label": "雜訊項 alpha", "type": "float", "default": 1e-6, "min": 1e-10, "max": 1.0, "step": 0.001,
                    "desc": "假設量測資料帶多少雜訊。資料越吵調越大，擬合會更平滑不強行穿過每個點。"}],
    },
    "BYS": {
        "name": "貝式迴歸 (BYS)", "tasks": TAB, "params": [],
        "desc": "把係數當機率分布估計的線性模型：自帶正則化、小樣本下穩定，不用手調參數。做分類時等於高斯樸素貝式。",
    },
    "DNN": {
        "name": "神經網路 (DNN)", "tasks": TAB,
        "desc": "多層神經元堆疊，理論上能逼近任何形狀的關係。需要較多資料餵養，訓練帶隨機性（同設定每次結果略異）；表格資料上未必贏過 XGB/RF。",
        "params": [
            {"key": "hidden", "label": "隱藏層（逗號分隔，如 64,64）", "type": "str", "default": "64,64",
             "desc": "網路結構：每層神經元數，逗號分隔。「64,64」＝兩層各 64 顆。層數/顆數越多容量越大，也越需要資料。"},
            {"key": "max_iter", "label": "迭代上限", "type": "int", "default": 500, "min": 50, "max": 5000,
             "desc": "訓練輪數上限。訓練未收斂（分數還在升）時調大。"},
            {"key": "alpha", "label": "L2 正則化 alpha", "type": "float", "default": 0.0001, "min": 1e-6, "max": 1.0, "step": 0.0001,
             "desc": "抑制過擬合的保險，過擬合時調大（如 0.001–0.01）。"},
        ],
    },
    # ---- 異常偵測（設備健康度：以健康運轉段為基準，無監督）----
    "PCA_T2": {
        "name": "PCA 多變量監控 (T²+SPE)", "tasks": ["anomaly"],
        "desc": "半導體／化工 FDC 監控的經典方法：把多個感測器的正常連動關係壓縮成少數主成分，新資料用兩個統計量衡量偏離——T²（主要模式內的偏移）＋SPE（模式外的殘差）。對「感測器間關係跑掉」這種單看各欄看不出的異常特別敏感。",
        "params": [{"key": "var_keep", "label": "保留變異比例", "type": "float", "default": 0.9, "min": 0.5, "max": 0.99, "step": 0.1,
                    "desc": "主成分要解釋原始資料多少比例的變化。調高（如 0.95）＝保留更多細節、對小異常敏感但也容易把雜訊當異常；調低（如 0.7）＝只看大方向、較不誤報。常用 0.8–0.95。"}],
    },
    "IFOREST": {
        "name": "隔離森林 (Isolation Forest)", "tasks": ["anomaly"],
        "desc": "隨機切割資料空間：異常點因為「稀少又長得不一樣」，很少幾刀就會被單獨切出來——需要的切割次數越少，風險分數越高。不假設資料分布形狀，對高維、混合型異常的通用性好。",
        "params": [{"key": "n_estimators", "label": "樹數", "type": "int", "default": 200, "min": 50, "max": 1000,
                    "desc": "隨機切割的重複次數。調大＝風險評分更穩定但訓練更久，200 通常夠。"}],
    },
    "OCSVM": {
        "name": "單類支持向量機 (One-Class SVM)", "tasks": ["anomaly"],
        "desc": "只用健康資料學出一個「包住正常區」的邊界，新資料落在邊界外＝異常。邊界可以是彎曲的（非線性核），適合正常區形狀不規則的資料。",
        "params": [{"key": "nu", "label": "異常比例上界 nu", "type": "float", "default": 0.05, "min": 0.001, "max": 0.5, "step": 0.01,
                    "desc": "預期訓練資料裡最多有多少比例其實不健康（0.05＝5%）。調大＝邊界收緊、更容易報異常；調小＝邊界寬鬆、只抓明顯異常。"}],
    },
    "LOF": {
        "name": "局部離群因子 (LOF)", "tasks": ["anomaly"],
        "desc": "比較每個點與鄰居的密度：如果一個點周圍明顯比它的鄰居們稀疏，就是局部離群。擅長抓「整體分布看似正常、但個別點在自己的小區域內很怪」的異常。",
        "params": [{"key": "n_neighbors", "label": "鄰居數", "type": "int", "default": 20, "min": 5, "max": 100,
                    "desc": "跟幾個鄰居比密度。調小＝對局部小異常敏感（也易誤報）；調大＝看更大範圍、更平滑。常用 10–50。"}],
    },
    "MAHAL": {
        "name": "穩健共變異 (Mahalanobis)", "tasks": ["anomaly"], "params": [],
        "desc": "把健康資料擬合成一個橢圓分布（考慮感測器間的相關性），用馬氏距離衡量新資料偏離中心多遠。感測器彼此相關時比逐欄設上下限準確；假設資料大致呈常態分布，計算快、無參數可調。",
    },
    # ---- 時序演算法（statsmodels 單變量預測；特徵工程請於上傳前完成）----
    "NAIVE": {
        "name": "Naive（最後值基準）", "tasks": ["timeseries"], "params": [],
        "desc": "用最後一筆觀測值當所有未來的預測——最簡單的基準線。任何正式模型都應該贏過它；贏不了就表示這份資料沒有可預測的結構。",
    },
    "SNAIVE": {
        "name": "Seasonal Naive（季節基準）", "tasks": ["timeseries"],
        "desc": "用「上一個週期同時刻」的值當預測（例如用昨天同一小時預測今天同一小時）。有明顯日／週週期性資料的基準線，同樣是用來檢驗正式模型有沒有真本事。",
        "params": [{"key": "s", "label": "季節週期 s（筆）", "type": "int", "default": 24, "min": 2, "max": 8760,
                    "desc": "一個週期含幾筆資料：小時資料的日週期＝24、日資料的週週期＝7。設錯週期會完全失準。"}],
    },
    "AR": {
        "name": "自迴歸 (AR)", "tasks": ["timeseries"],
        "desc": "用前面 p 筆觀測值的加權組合預測下一筆——假設未來延續近期的慣性。結構簡單、訓練快，適合平穩、無明顯季節性的序列。",
        "params": [{"key": "lags", "label": "階數 p", "type": "int", "default": 8, "min": 1, "max": 96,
                    "desc": "往回看幾筆資料。調大＝參考更長的歷史（可涵蓋週期），但參數變多需要更多資料支撐。"}],
    },
    "ARIMA": {
        "name": "ARIMA", "tasks": ["timeseries"],
        "desc": "時序預測的經典組合拳：AR（自迴歸，看過去值）＋ I（差分，先去除趨勢）＋ MA（移動平均，看過去的預測誤差）。能處理有趨勢的非平穩資料，是不知道選什麼時的標準起手式。",
        "params": [
            {"key": "p", "label": "AR 階數 p", "type": "int", "default": 2, "min": 0, "max": 10,
             "desc": "自迴歸項：參考前幾筆「觀測值」。序列慣性強調大。"},
            {"key": "d", "label": "差分階數 d", "type": "int", "default": 1, "min": 0, "max": 2,
             "desc": "先對序列做幾次「相鄰相減」去趨勢。有明顯上升/下降趨勢用 1，通常不超過 2。"},
            {"key": "q", "label": "MA 階數 q", "type": "int", "default": 2, "min": 0, "max": 10,
             "desc": "移動平均項：參考前幾筆「預測誤差」來修正。短期震盪明顯時調大。"},
        ],
    },
    "SARIMA": {
        "name": "SARIMA（季節性）", "tasks": ["timeseries"],
        "desc": "ARIMA 加上季節項：同時抓短期慣性與固定週期模式（日夜循環、週循環）。資料有明顯週期性時比 ARIMA 準，但參數多、訓練慢。",
        "params": [
            {"key": "p", "label": "p", "type": "int", "default": 1, "min": 0, "max": 5,
             "desc": "非季節 AR 階數（參考前幾筆觀測值）。"},
            {"key": "d", "label": "d", "type": "int", "default": 1, "min": 0, "max": 2,
             "desc": "非季節差分次數（去趨勢）。"},
            {"key": "q", "label": "q", "type": "int", "default": 1, "min": 0, "max": 5,
             "desc": "非季節 MA 階數（參考前幾筆誤差）。"},
            {"key": "P", "label": "季節 P", "type": "int", "default": 1, "min": 0, "max": 3,
             "desc": "季節版 AR：參考「前幾個週期同時刻」的觀測值。"},
            {"key": "D", "label": "季節 D", "type": "int", "default": 0, "min": 0, "max": 1,
             "desc": "季節差分：與上個週期同時刻相減，去除週期性水準變化。"},
            {"key": "Q", "label": "季節 Q", "type": "int", "default": 1, "min": 0, "max": 3,
             "desc": "季節版 MA：參考前幾個週期同時刻的誤差。"},
            {"key": "s", "label": "季節週期 s", "type": "int", "default": 24, "min": 2, "max": 8760,
             "desc": "一個週期含幾筆：小時資料日週期＝24、日資料週週期＝7。"},
        ],
    },
    "ETS": {
        "name": "指數平滑 (Holt-Winters)", "tasks": ["timeseries"],
        "desc": "「越近期的資料越重要、越久遠越淡忘」的加權平均，可再疊加趨勢與季節成分。直覺、穩健、訓練快，需求預測領域的長青樹。",
        "params": [
            {"key": "trend", "label": "趨勢", "type": "choice", "default": "add", "choices": ["add", "mul", "none"],
             "desc": "趨勢成分：add＝直線式上升/下降、mul＝百分比式成長、none＝無趨勢。"},
            {"key": "seasonal", "label": "季節性", "type": "choice", "default": "none", "choices": ["add", "mul", "none"],
             "desc": "季節成分：add＝週期波動幅度固定、mul＝波動隨水準放大、none＝無季節性。"},
            {"key": "s", "label": "季節週期 s", "type": "int", "default": 24, "min": 2, "max": 8760,
             "desc": "一個週期含幾筆（季節性非 none 時才生效）。"},
        ],
    },
    "THETA": {
        "name": "Theta 模型", "tasks": ["timeseries"],
        "desc": "M3 預測競賽的成名方法：把序列拆成長期趨勢線與短期記憶兩條再合成。實務上常常「又快又準」，適合當時序任務的預設選擇之一。",
        "params": [{"key": "period", "label": "季節週期", "type": "int", "default": 24, "min": 2, "max": 8760,
                    "desc": "一個週期含幾筆，用於先做季節調整。"}],
    },
}

# 自動調參搜尋空間（RandomizedSearchCV）
TUNE_SPACE = {
    "RIDGE": {"model__alpha": [0.01, 0.1, 1, 10, 100]},
    "LASSO": {"model__alpha": [0.001, 0.01, 0.1, 1]},
    "HUBER": {"model__epsilon": [1.1, 1.35, 2.0], "model__alpha": [1e-5, 1e-4, 1e-3]},
    "PLS": {"model__n_components": [2, 4, 6, 10]},
    "DT": {"model__max_depth": [None, 4, 8, 16], "model__min_samples_leaf": [1, 3, 9]},
    "ET": {"model__n_estimators": [100, 300, 600], "model__max_depth": [None, 8, 16]},
    "ADA": {"model__n_estimators": [50, 100, 200], "model__learning_rate": [0.1, 0.5, 1.0]},
    "GNET": {"model__alpha": [0.01, 0.1, 1, 10], "model__l1_ratio": [0.1, 0.5, 0.9]},
    "GAM": {"spline__n_knots": [5, 8, 12, 20], "model__alpha": [0.1, 1, 10]},
    "SVM": {"model__C": [0.1, 1, 10, 100], "model__epsilon": [0.01, 0.1, 0.5]},
    "KNN": {"model__n_neighbors": [3, 5, 9, 15, 25], "model__weights": ["uniform", "distance"]},
    "XGB": {"model__max_iter": [100, 200, 400], "model__learning_rate": [0.03, 0.1, 0.3],
            "model__max_depth": [None, 4, 8]},
    "RF": {"model__n_estimators": [100, 300, 600], "model__max_depth": [None, 8, 16],
           "model__min_samples_leaf": [1, 3, 9]},
    "DNN": {"model__hidden_layer_sizes": [(64,), (64, 64), (128, 64)],
            "model__alpha": [1e-5, 1e-4, 1e-3]},
}


def _build_pipeline(algo: str, params: dict, task: str = "regression"):
    from sklearn.ensemble import (HistGradientBoostingClassifier, HistGradientBoostingRegressor,
                                  RandomForestClassifier, RandomForestRegressor)
    from sklearn.linear_model import BayesianRidge, ElasticNet, LinearRegression, LogisticRegression, Ridge
    from sklearn.naive_bayes import GaussianNB
    from sklearn.neighbors import KNeighborsClassifier, KNeighborsRegressor
    from sklearn.neural_network import MLPClassifier, MLPRegressor
    from sklearn.pipeline import Pipeline
    from sklearn.preprocessing import SplineTransformer, StandardScaler
    from sklearn.svm import SVC, SVR

    from sklearn.cross_decomposition import PLSRegression
    from sklearn.ensemble import AdaBoostClassifier, AdaBoostRegressor, ExtraTreesClassifier, ExtraTreesRegressor
    from sklearn.gaussian_process import GaussianProcessRegressor
    from sklearn.linear_model import HuberRegressor, Lasso, RidgeClassifier
    from sklearn.tree import DecisionTreeClassifier, DecisionTreeRegressor

    p = {k: v for k, v in (params or {}).items() if v is not None and v != ""}
    cls = task == "classification"
    steps = [("scaler", StandardScaler())]
    if algo == "GLM":
        model = LogisticRegression(max_iter=2000) if cls else LinearRegression()
    elif algo == "RIDGE":
        model = (RidgeClassifier(alpha=float(p.get("alpha", 1.0)))
                 if cls else Ridge(alpha=float(p.get("alpha", 1.0))))
    elif algo == "LASSO":
        model = (LogisticRegression(penalty="l1", solver="saga", max_iter=3000,
                                    C=1.0 / max(float(p.get("alpha", 0.1)), 1e-6))
                 if cls else Lasso(alpha=float(p.get("alpha", 0.1)), max_iter=5000))
    elif algo == "HUBER":
        model = HuberRegressor(epsilon=float(p.get("epsilon", 1.35)), alpha=float(p.get("alpha", 1e-4)))
    elif algo == "PLS":
        model = PLSRegression(n_components=int(p.get("n_components", 4)))
    elif algo == "DT":
        klass = DecisionTreeClassifier if cls else DecisionTreeRegressor
        model = klass(max_depth=int(p["max_depth"]) if p.get("max_depth") else None,
                      min_samples_leaf=int(p.get("min_samples_leaf", 3)), random_state=0)
    elif algo == "ET":
        klass = ExtraTreesClassifier if cls else ExtraTreesRegressor
        model = klass(n_estimators=int(p.get("n_estimators", 300)),
                      max_depth=int(p["max_depth"]) if p.get("max_depth") else None,
                      random_state=0, n_jobs=-1)
    elif algo == "ADA":
        klass = AdaBoostClassifier if cls else AdaBoostRegressor
        model = klass(n_estimators=int(p.get("n_estimators", 100)),
                      learning_rate=float(p.get("learning_rate", 1.0)), random_state=0)
    elif algo == "GPR":
        model = GaussianProcessRegressor(alpha=float(p.get("alpha", 1e-6)),
                                         normalize_y=True, random_state=0)
    elif algo == "GNET":
        model = (LogisticRegression(penalty="elasticnet", solver="saga", max_iter=3000,
                                    C=1.0 / max(float(p.get("alpha", 1.0)), 1e-6),
                                    l1_ratio=float(p.get("l1_ratio", 0.5)))
                 if cls else
                 ElasticNet(alpha=float(p.get("alpha", 1.0)), l1_ratio=float(p.get("l1_ratio", 0.5)), max_iter=5000))
    elif algo == "GAM":
        steps.append(("spline", SplineTransformer(n_knots=int(p.get("n_knots", 8)), degree=3)))
        model = (LogisticRegression(max_iter=2000, C=1.0 / max(float(p.get("alpha", 1.0)), 1e-6))
                 if cls else Ridge(alpha=float(p.get("alpha", 1.0))))
    elif algo == "SVM":
        model = (SVC(C=float(p.get("C", 1.0)), gamma=p.get("gamma", "scale"), probability=True, random_state=0)
                 if cls else
                 SVR(C=float(p.get("C", 1.0)), epsilon=float(p.get("epsilon", 0.1)), gamma=p.get("gamma", "scale")))
    elif algo == "KNN":
        klass = KNeighborsClassifier if cls else KNeighborsRegressor
        model = klass(n_neighbors=int(p.get("n_neighbors", 5)), weights=p.get("weights", "uniform"))
    elif algo == "XGB":
        klass = HistGradientBoostingClassifier if cls else HistGradientBoostingRegressor
        model = klass(
            max_iter=int(p.get("max_iter", 200)), learning_rate=float(p.get("learning_rate", 0.1)),
            max_depth=int(p["max_depth"]) if p.get("max_depth") else None,
            l2_regularization=float(p.get("l2_regularization", 0.0)), random_state=0)
    elif algo == "RF":
        klass = RandomForestClassifier if cls else RandomForestRegressor
        model = klass(
            n_estimators=int(p.get("n_estimators", 300)),
            max_depth=int(p["max_depth"]) if p.get("max_depth") else None,
            min_samples_leaf=int(p.get("min_samples_leaf", 1)), random_state=0, n_jobs=-1)
    elif algo == "BYS":
        model = GaussianNB() if cls else BayesianRidge()
    elif algo == "DNN":
        hidden = tuple(int(x) for x in str(p.get("hidden", "64,64")).split(",") if x.strip())
        klass = MLPClassifier if cls else MLPRegressor
        model = klass(hidden_layer_sizes=hidden or (64, 64), max_iter=int(p.get("max_iter", 500)),
                      alpha=float(p.get("alpha", 1e-4)), random_state=0)
    else:
        raise HTTPException(422, f"未知演算法 {algo}")
    steps.append(("model", model))
    return Pipeline(steps)


# ------------------------------------------------------ 儲存
def _mdir(sid: str) -> Path:
    d = AUTOML_DIR / sid
    d.mkdir(parents=True, exist_ok=True)
    return d


def _mpath(sid: str, mid: str) -> Path:
    return _mdir(sid) / f"{mid}.json"


def _save(sid: str, rec: dict):
    _mpath(sid, rec["id"]).write_text(json.dumps(rec, ensure_ascii=False), encoding="utf-8")


def _load(sid: str, mid: str) -> dict:
    p = _mpath(sid, mid)
    if not p.exists():
        raise HTTPException(404, "模型不存在")
    return json.loads(p.read_text(encoding="utf-8"))


# ------------------------------------------------------ 共用 helper
def _current_xy(sid: str, rec: dict):
    """現行視圖（steps 重放後）取 target/features；評估/試算/優化同源。"""
    df = _load_base(sid)
    view, *_ = apply_steps(df, _load_steps(sid))
    missing = [c for c in (rec["target"], *rec["features"]) if c not in view.columns]
    if missing:
        raise HTTPException(422, f"現行視圖缺少欄位：{missing}")
    feats = view[rec["features"]].apply(pd.to_numeric, errors="coerce")
    if rec.get("task") == "classification":
        tgt = view[rec["target"]].astype(str)
    else:
        tgt = pd.to_numeric(view[rec["target"]], errors="coerce")
    data = pd.concat([tgt.rename(rec["target"]), feats], axis=1).dropna()
    # 強制 numpy：parquet 回讀的字串欄是 Arrow-backed，.values 給 ArrowExtensionArray，
    # sklearn 的 fancy indexing 會炸（pyarrow scalar index error）
    X = data[rec["features"]].to_numpy(dtype=float)
    if rec.get("task") == "classification":
        y = np.asarray(data[rec["target"]].tolist(), dtype=object)
    else:
        y = data[rec["target"]].to_numpy(dtype=float)
    return X, y


def _pipe_path(sid: str, mid: str) -> Path:
    return _mdir(sid) / f"{mid}.joblib"


def _load_pipe(sid: str, mid: str):
    import joblib
    p = _pipe_path(sid, mid)
    if not p.exists():
        raise HTTPException(422, "此模型未保存訓練成品（一期舊模型）——請重新訓練後再使用此功能")
    return joblib.load(p)


def _baseline(sid: str, rec: dict) -> dict:
    """what-if / 優化的基準點＝現行視圖各特徵中位數。"""
    X, _ = _current_xy(sid, rec)
    med = np.median(X, axis=0)
    return {f: round(float(med[i]), 6) for i, f in enumerate(rec["features"])}


def _ts_series(sid: str, rec: dict):
    """時序單變量序列：現行視圖依時間欄排序的目標值（特徵工程請於上傳前完成）。"""
    ts = rec.get("ts") or {}
    tcol = ts.get("time_col")
    df = _load_base(sid)
    view, *_ = apply_steps(df, _load_steps(sid))
    if tcol not in view.columns or not pd.api.types.is_datetime64_any_dtype(view[tcol]):
        raise HTTPException(422, f"時序模型需要時間欄（{tcol} 不存在或非時間型態）")
    d = view[[tcol, rec["target"]]].copy()
    d[rec["target"]] = pd.to_numeric(d[rec["target"]], errors="coerce")
    d = d.dropna().sort_values(tcol)
    y = d[rec["target"]].to_numpy(dtype=float)
    t = ((d[tcol] - pd.Timestamp(0)) // pd.Timedelta(seconds=1)).to_numpy(dtype=float)
    return y, t


def _ts_forecast(algo: str, params: dict, ytr: np.ndarray, steps: int):
    """以訓練段擬合時序模型並外推 steps 筆。回 (forecast, fitted-in-sample|None)。"""
    p = {k: v for k, v in (params or {}).items() if v is not None and v != ""}
    if algo == "NAIVE":
        return np.full(steps, ytr[-1]), None
    if algo == "SNAIVE":
        s = int(p.get("s", 24))
        if s >= len(ytr):
            return np.full(steps, ytr[-1]), None
        return np.array([ytr[-s + (i % s)] for i in range(steps)]), None
    if algo == "AR":
        from statsmodels.tsa.ar_model import AutoReg
        lags = min(int(p.get("lags", 8)), max(1, len(ytr) // 4))
        res = AutoReg(ytr, lags=lags, old_names=False).fit()
        fc = res.predict(start=len(ytr), end=len(ytr) + steps - 1)
        return np.asarray(fc, float), np.asarray(res.fittedvalues, float)
    if algo == "ARIMA":
        from statsmodels.tsa.arima.model import ARIMA
        res = ARIMA(ytr, order=(int(p.get("p", 2)), int(p.get("d", 1)), int(p.get("q", 2)))).fit()
        return np.asarray(res.forecast(steps), float), np.asarray(res.fittedvalues, float)
    if algo == "SARIMA":
        from statsmodels.tsa.statespace.sarimax import SARIMAX
        res = SARIMAX(ytr, order=(int(p.get("p", 1)), int(p.get("d", 1)), int(p.get("q", 1))),
                      seasonal_order=(int(p.get("P", 1)), int(p.get("D", 0)), int(p.get("Q", 1)), int(p.get("s", 24))),
                      enforce_stationarity=False, enforce_invertibility=False).fit(disp=0)
        return np.asarray(res.forecast(steps), float), np.asarray(res.fittedvalues, float)
    if algo == "ETS":
        from statsmodels.tsa.holtwinters import ExponentialSmoothing
        trend = None if p.get("trend", "add") == "none" else p.get("trend", "add")
        seasonal = None if p.get("seasonal", "none") == "none" else p.get("seasonal")
        res = ExponentialSmoothing(ytr, trend=trend, seasonal=seasonal,
                                   seasonal_periods=int(p.get("s", 24)) if seasonal else None,
                                   initialization_method="estimated").fit()
        return np.asarray(res.forecast(steps), float), np.asarray(res.fittedvalues, float)
    if algo == "THETA":
        from statsmodels.tsa.forecasting.theta import ThetaModel
        res = ThetaModel(pd.Series(ytr), period=int(p.get("period", 24))).fit()
        return res.forecast(steps).to_numpy(dtype=float), None
    raise HTTPException(422, f"未知時序演算法 {algo}")


# ------------------------------------------------------ 異常偵測（設備健康度）
def _anomaly_xt(sid: str, rec: dict):
    """監測欄位矩陣＋時間軸（有時間欄時）。現行視圖＝健康基準假設。"""
    df = _load_base(sid)
    view, *_ = apply_steps(df, _load_steps(sid))
    missing = [c for c in rec["features"] if c not in view.columns]
    if missing:
        raise HTTPException(422, f"現行視圖缺少欄位：{missing}")
    feats = view[rec["features"]].apply(pd.to_numeric, errors="coerce")
    tcol = next((c for c in view.columns if pd.api.types.is_datetime64_any_dtype(view[c])), None)
    if tcol:
        t = (view[tcol] - pd.Timestamp(0)) / pd.Timedelta(seconds=1)
        data = pd.concat([t.rename("__t__"), feats], axis=1).dropna()
        return data[rec["features"]].to_numpy(dtype=float), data["__t__"].to_numpy(dtype=float), True
    data = feats.dropna()
    return data.to_numpy(dtype=float), np.arange(len(data), dtype=float), False


def _fit_anomaly(algo: str, params: dict, Xtr: np.ndarray) -> dict:
    """以健康基準擬合，回可 joblib 的 meta（純物件，無 closure）。"""
    from sklearn.preprocessing import StandardScaler
    p = {k: v for k, v in (params or {}).items() if v is not None and v != ""}
    sc = StandardScaler().fit(Xtr)
    Z = sc.transform(Xtr)
    if algo == "PCA_T2":
        from sklearn.decomposition import PCA
        pca = PCA(n_components=min(float(p.get("var_keep", 0.9)), 0.99), svd_solver="full").fit(Z)
        lam = np.maximum(pca.explained_variance_, 1e-12)
        T = pca.transform(Z)
        t2 = ((T ** 2) / lam).sum(axis=1)
        spe = ((Z - pca.inverse_transform(T)) ** 2).sum(axis=1)
        # 正規化基準用「訓練段」中位數（新資料評分才可比）
        return {"scaler": sc, "pca": pca, "lam": lam,
                "med_t2": max(float(np.median(t2)), 1e-9), "med_spe": max(float(np.median(spe)), 1e-9)}
    if algo == "IFOREST":
        from sklearn.ensemble import IsolationForest
        m = IsolationForest(n_estimators=int(p.get("n_estimators", 200)), random_state=0).fit(Z)
        return {"scaler": sc, "model": m}
    if algo == "OCSVM":
        from sklearn.svm import OneClassSVM
        m = OneClassSVM(nu=float(p.get("nu", 0.05)), gamma="scale").fit(Z)
        return {"scaler": sc, "model": m}
    if algo == "LOF":
        from sklearn.neighbors import LocalOutlierFactor
        m = LocalOutlierFactor(n_neighbors=int(p.get("n_neighbors", 20)), novelty=True).fit(Z)
        return {"scaler": sc, "model": m}
    if algo == "MAHAL":
        from sklearn.covariance import EllipticEnvelope
        m = EllipticEnvelope(support_fraction=0.9, random_state=0).fit(Z)
        return {"scaler": sc, "model": m}
    raise HTTPException(422, f"未知異常偵測演算法 {algo}")


def _anomaly_score(algo: str, meta: dict, X: np.ndarray) -> np.ndarray:
    """以已擬合 meta 對任意資料計算風險值（越高越異常）。"""
    Z = meta["scaler"].transform(X)
    if algo == "PCA_T2":
        T = meta["pca"].transform(Z)
        t2 = ((T ** 2) / meta["lam"]).sum(axis=1)
        spe = ((Z - meta["pca"].inverse_transform(T)) ** 2).sum(axis=1)
        return t2 / meta["med_t2"] + spe / meta["med_spe"]
    if algo == "IFOREST":
        return -meta["model"].score_samples(Z)
    if algo in ("OCSVM", "LOF"):
        return -meta["model"].decision_function(Z)
    if algo == "MAHAL":
        return meta["model"].mahalanobis(Z)
    raise HTTPException(422, f"未知異常偵測演算法 {algo}")


THRESH_METHODS = {
    "p99": ("風險值 99 百分位", lambda r: float(np.percentile(r, 99))),
    "p995": ("風險值 99.5 百分位", lambda r: float(np.percentile(r, 99.5))),
    "sigma3": ("平均 + 3 倍標準差", lambda r: float(r.mean() + 3 * r.std())),
    "iqr": ("IQR 上界（Q3 + 1.5×IQR）", lambda r: float(np.percentile(r, 75) + 1.5 * (np.percentile(r, 75) - np.percentile(r, 25)))),
}


def _health_from_risk(risk: np.ndarray, thr: float) -> np.ndarray:
    """風險值 → 健康分數 0–100：risk=0 → 100、risk=門檻 → 50、risk≥2×門檻 → 0（線性）。"""
    return np.clip(100.0 * (1.0 - risk / max(2.0 * thr, 1e-9)), 0, 100)


def _health_forecast(t: np.ndarray, health: np.ndarray, has_time: bool):
    """7 天健康預測（Edge 摘要卡）：日均聚合 → Theil-Sen 穩健趨勢 → 外推 7 天。
    無時間欄或有效天數 <3 時「天」無定義，回 None。"""
    if not has_time or len(t) < 20:
        return None
    day = 86400.0
    days = np.floor(np.asarray(t) / day)
    uniq = np.unique(days)[-30:]  # 最近 30 個有資料的日
    if len(uniq) < 3:
        return None
    ys = np.array([health[days == d].mean() for d in uniq])
    from scipy.stats import theilslopes
    slope, intercept, *_ = theilslopes(ys, uniq)
    fut = uniq[-1] + np.arange(1, 8, dtype=float)
    pred = np.clip(intercept + slope * fut, 0, 100)
    return {"t": ((fut + 0.5) * day).tolist(),  # 每日中點時間戳
            "score": np.round(pred, 1).tolist(),
            "day7": round(float(pred[-1]), 1),
            "slope": round(float(slope), 2)}


def _anomaly_events(risk: np.ndarray, thr: float, t: np.ndarray,
                    X: np.ndarray, features: list, mu, sd) -> list:
    """連續超標段 → 故障事件列表（起訖、峰值風險、主導感測器）。"""
    events = []
    i = 0
    while i < len(risk):
        if risk[i] > thr:
            j = i
            while j + 1 < len(risk) and risk[j + 1] > thr:
                j += 1
            seg = slice(i, j + 1)
            zi = np.abs((X[seg] - mu) / sd).mean(axis=0)
            events.append({"t_start": float(t[i]), "t_end": float(t[j]),
                           "n": int(j - i + 1),
                           "peak_risk": round(float(risk[seg].max()), 5),
                           "min_health": round(float(_health_from_risk(risk[seg], thr).min()), 1),
                           "top_sensor": features[int(np.argmax(zi))]})
            i = j + 1
        else:
            i += 1
    events.sort(key=lambda e: -e["peak_risk"])
    return events[:20]


def _fdc_charts(X: np.ndarray, t: np.ndarray, features: list, mu, sd) -> dict:
    """FDC/SPC 管制圖資料：各感測器序列＋管制界限（UCL/LCL=μ±3σ、UWL/LWL=μ±2σ）。"""
    step = max(1, len(t) // 500)
    return {"t": t[::step].tolist(),
            "cols": [{"name": f,
                      "y": np.round(X[::step, i], 5).tolist(),
                      "ucl": round(float(mu[i] + 3 * sd[i]), 5), "lcl": round(float(mu[i] - 3 * sd[i]), 5),
                      "uwl": round(float(mu[i] + 2 * sd[i]), 5), "lwl": round(float(mu[i] - 2 * sd[i]), 5)}
                     for i, f in enumerate(features)]}


def _run_anomaly(sid: str, rec: dict):
    """異常偵測訓練：健康基準擬合→風險值→健康分數 0-100＋FDC 管制圖＋故障事件（PHM 呈現）。"""
    import joblib
    X, t, has_time = _anomaly_xt(sid, rec)
    if len(X) < 30:
        raise ValueError(f"有效樣本僅 {len(X)} 筆（<30），不足以建立基準")
    meta = _fit_anomaly(rec["algo"], rec.get("params"), X)
    risk = np.asarray(_anomaly_score(rec["algo"], meta, X), float)
    thr = THRESH_METHODS["p99"][1](risk)
    exceed = risk > thr
    health = _health_from_risk(risk, thr)
    mu, sd = X.mean(axis=0), np.maximum(X.std(axis=0), 1e-9)
    # 目前健康分數＝末端 5% 平均（近期狀態），全段最低為谷值
    n_tail = max(5, len(health) // 20)
    health_now = round(float(health[-n_tail:].mean()), 1)
    events = _anomaly_events(risk, thr, t, X, rec["features"], mu, sd)
    pred = _health_forecast(t, health, has_time)
    rec["metrics_cv"] = {"health_now": health_now, "threshold": round(thr, 5),
                         "exceed_pct": round(float(exceed.mean()) * 100, 3),
                         "n_events": len(events),
                         "health_7d": pred["day7"] if pred else None}
    rec["metrics_train"] = rec["metrics_cv"]
    rec["val_desc"] = "健康基準＝現行視圖；預設門檻＝P99"
    step = max(1, len(risk) // 900)
    rec["plots"] = {
        "risk": {"t": t[::step].tolist(), "risk": np.round(risk[::step], 5).tolist(),
                 "threshold": round(thr, 5)},
        "health": {"t": t[::step].tolist(), "score": np.round(health[::step], 1).tolist()},
        "health_pred": pred,
        "fdc": _fdc_charts(X, t, rec["features"], mu, sd),
    }
    rec["events"] = events
    # 貢獻度：超標點各欄位 |z| 平均（哪些感測器把風險推高）
    zi = np.abs((X[exceed] - mu) / sd) if exceed.any() else np.abs((X - mu) / sd)
    contrib = zi.mean(axis=0)
    order = np.argsort(contrib)[::-1][:15]
    rec["plots"]["fi"] = {"names": [rec["features"][i] for i in order],
                          "values": np.round(contrib[order], 4).tolist()}
    rec["n_rows"] = int(len(X))
    joblib.dump({"algo": rec["algo"], "params": rec.get("params"), "meta": meta,
                 "mu": mu.tolist(), "sd": sd.tolist()}, _pipe_path(sid, rec["id"]))
    rec["status"] = "done"


# ------------------------------------------------------ 混合模型（物理模擬＋AI 殘差）
def _hybrid_xy(sid: str, rec: dict):
    """混合模型資料：X（特徵）、y（實際目標）、ysim（模擬基準欄，如 ASPEN 產出）。"""
    df = _load_base(sid)
    view, *_ = apply_steps(df, _load_steps(sid))
    sim = rec.get("sim_col")
    missing = [c for c in (rec["target"], sim, *rec["features"]) if c not in view.columns]
    if missing:
        raise HTTPException(422, f"現行視圖缺少欄位：{missing}")
    cols = [rec["target"], sim, *rec["features"]]
    data = view[cols].apply(pd.to_numeric, errors="coerce").dropna()
    return (data[rec["features"]].to_numpy(dtype=float),
            data[rec["target"]].to_numpy(dtype=float),
            data[sim].to_numpy(dtype=float))


def _cv_splits(n: int, cfg: dict):
    """依驗證設定產生 (train_idx, test_idx) 序列——混合模型三個管線要吃同一組切分。"""
    m = cfg["method"]
    idx = np.arange(n)
    if m == "holdout":
        n_te = max(5, int(n * cfg["test_size"]))
        if cfg["shuffle"]:
            perm = np.random.RandomState(0).permutation(n)
            yield perm[n_te:], perm[:n_te]
        else:
            yield idx[:-n_te], idx[-n_te:]
    elif m == "timesplit":
        from sklearn.model_selection import TimeSeriesSplit
        yield from TimeSeriesSplit(n_splits=cfg["n_splits"]).split(idx)
    else:
        from sklearn.model_selection import KFold
        kf = KFold(n_splits=cfg["k"], shuffle=cfg["shuffle"],
                   random_state=0 if cfg["shuffle"] else None)
        yield from kf.split(idx)


VAL_NAMES = {"kfold": "K 折交叉驗證", "holdout": "保留法", "timesplit": "時序切分"}


def _run_hybrid(sid: str, rec: dict):
    """混合模型＝g(x)（模擬代理，蒸餾 ASPEN 等物理模擬）＋ r(x)（殘差修正，學實廠與模擬的差）。
    同一組 CV 切分下算三方對比：純模擬基準／純 AI 對照／混合——給客戶的可信度證據。"""
    import joblib
    from sklearn.inspection import permutation_importance

    X, y, ysim = _hybrid_xy(sid, rec)
    if len(y) < 30:
        raise ValueError(f"有效樣本僅 {len(y)} 筆（<30），不足以訓練")
    cfg = _validation_cfg(rec)
    algo, params = rec["algo"], rec.get("params")
    resid = y - ysim
    # 同折 OOF：g 學模擬、r 學殘差、a 純 AI 對照
    oof_g = np.full(len(y), np.nan)
    oof_r = np.full(len(y), np.nan)
    oof_a = np.full(len(y), np.nan)
    for tr, te in _cv_splits(len(y), cfg):
        g = _build_pipeline(algo, params, "regression").fit(X[tr], ysim[tr])
        r = _build_pipeline(algo, params, "regression").fit(X[tr], resid[tr])
        a = _build_pipeline(algo, params, "regression").fit(X[tr], y[tr])
        oof_g[te] = np.ravel(g.predict(X[te]))
        oof_r[te] = np.ravel(r.predict(X[te]))
        oof_a[te] = np.ravel(a.predict(X[te]))
    mask = ~np.isnan(oof_g)
    hybrid = oof_g + oof_r
    rec["compare"] = {"sim": _metrics(y[mask], ysim[mask]),
                      "ai": _metrics(y[mask], oof_a[mask]),
                      "hybrid": _metrics(y[mask], hybrid[mask])}
    rec["metrics_cv"] = rec["compare"]["hybrid"]
    rec["val_desc"] = VAL_NAMES.get(cfg["method"], cfg["method"])
    # 全量 refit 持久化＋訓練集指標
    pipe_g = _build_pipeline(algo, params, "regression").fit(X, ysim)
    pipe_r = _build_pipeline(algo, params, "regression").fit(X, resid)
    train_pred = np.ravel(pipe_g.predict(X)) + np.ravel(pipe_r.predict(X))
    rec["metrics_train"] = _metrics(y, train_pred)
    # 圖：混合 OOF 的準確度＋誤差；FI＝殘差模型（AI 到底修正了什麼）
    idx = np.random.RandomState(0).choice(int(mask.sum()), min(600, int(mask.sum())), replace=False)
    ym, hm = y[mask][idx], hybrid[mask][idx]
    rec["plots"] = {
        "pa": {"actual": np.round(ym, 4).tolist(), "pred": np.round(hm, 4).tolist()},
        "err": {"actual": np.round(ym, 4).tolist(), "error": np.round(ym - hm, 4).tolist()},
    }
    sub = np.random.RandomState(0).choice(len(y), min(1500, len(y)), replace=False)
    imp = permutation_importance(pipe_r, X[sub], resid[sub], n_repeats=5, random_state=0, n_jobs=1)
    order = np.argsort(imp.importances_mean)[::-1][:15]
    rec["plots"]["fi"] = {"names": [rec["features"][i] for i in order],
                          "values": np.round(imp.importances_mean[order], 5).tolist()}
    rec["n_rows"] = int(len(y))
    joblib.dump({"kind": "hybrid", "g": pipe_g, "r": pipe_r}, _pipe_path(sid, rec["id"]))
    rec["status"] = "done"


def _predict_any(pack, X: np.ndarray) -> np.ndarray:
    """統一推論：混合模型（{kind:'hybrid',g,r}）＝代理＋殘差；其餘為單一 pipeline。"""
    if isinstance(pack, dict) and pack.get("kind") == "hybrid":
        return np.ravel(pack["g"].predict(X)) + np.ravel(pack["r"].predict(X))
    return pack.predict(X)


# ------------------------------------------------------ 驗證方法（使用者可選）
def _validation_cfg(rec: dict) -> dict:
    v = rec.get("validation") or {}
    return {"method": v.get("method", "kfold"),
            "k": min(10, max(2, int(v.get("k") or 5))),
            "test_size": min(0.5, max(0.05, float(v.get("test_size") or 0.2))),
            "shuffle": v.get("shuffle", True) not in (False, "false", "0"),
            "n_splits": min(10, max(2, int(v.get("n_splits") or 5)))}


def _validate_tabular(pipe, X, y, cls: bool, cfg: dict):
    """依驗證設定產生驗證對 (y_val, yhat_val, 描述)。"""
    from sklearn.model_selection import (KFold, StratifiedKFold, TimeSeriesSplit,
                                         cross_val_predict, train_test_split)
    m = cfg["method"]
    if m == "holdout":
        pct = int(cfg["test_size"] * 100)
        if cfg["shuffle"]:
            Xtr, Xte, ytr, yte = train_test_split(X, y, test_size=cfg["test_size"], random_state=0,
                                                  stratify=y if cls else None)
            desc = f"保留法（隨機抽 {pct}% 測試）"
        else:
            n_te = max(5, int(len(y) * cfg["test_size"]))
            Xtr, Xte, ytr, yte = X[:-n_te], X[-n_te:], y[:-n_te], y[-n_te:]
            desc = f"保留法（資料末端 {pct}% 測試）"
        pipe.fit(Xtr, ytr)
        return yte, np.ravel(pipe.predict(Xte)) if not cls else pipe.predict(Xte), desc
    if m == "timesplit":
        oof_i, oof_p = [], []
        for tr, te in TimeSeriesSplit(n_splits=cfg["n_splits"]).split(X):
            pipe.fit(X[tr], y[tr])
            oof_i.extend(te.tolist())
            oof_p.extend(np.ravel(pipe.predict(X[te])).tolist() if not cls
                         else list(pipe.predict(X[te])))
        oof_i = np.array(oof_i)
        return y[oof_i], np.asarray(oof_p), f"時序切分（{cfg['n_splits']} 折走前）"
    rs = 0 if cfg["shuffle"] else None
    cv = StratifiedKFold(cfg["k"], shuffle=cfg["shuffle"], random_state=rs) if cls \
        else KFold(cfg["k"], shuffle=cfg["shuffle"], random_state=rs)
    yhat = cross_val_predict(pipe, X, y, cv=cv)
    return y, (np.ravel(yhat) if not cls else yhat), f"{cfg['k']} 折交叉驗證{'' if cfg['shuffle'] else '（不洗牌）'}"


# ------------------------------------------------------ 指標
def _metrics_cls(y, yhat) -> dict:
    from sklearn.metrics import accuracy_score, f1_score, precision_score, recall_score
    return {"accuracy": round(float(accuracy_score(y, yhat)), 5),
            "f1": round(float(f1_score(y, yhat, average="macro", zero_division=0)), 5),
            "precision": round(float(precision_score(y, yhat, average="macro", zero_division=0)), 5),
            "recall": round(float(recall_score(y, yhat, average="macro", zero_division=0)), 5)}


def _metrics(y, yhat) -> dict:
    # ravel：PLS 等模型輸出 (n,1)，不壓平會廣播成 (n,n)
    y, yhat = np.asarray(y, float).ravel(), np.asarray(yhat, float).ravel()
    err = y - yhat
    ss_res = float((err ** 2).sum())
    ss_tot = float(((y - y.mean()) ** 2).sum()) or 1e-12
    with np.errstate(divide="ignore", invalid="ignore"):
        ape = np.arctan(np.abs(np.where(y != 0, err / y, err)))  # MAAPE（Tukey 同款指標）
    return {"rmse": round(float(np.sqrt((err ** 2).mean())), 5),
            "mae": round(float(np.abs(err).mean()), 5),
            "maape": round(float(ape.mean()), 7),
            "r2": round(1 - ss_res / ss_tot, 5)}


def _run_ts(sid: str, rec: dict):
    """時序訓練：尾端保留驗證——訓練段擬合、外推測試段、對照實際。"""
    y, t = _ts_series(sid, rec)
    if len(y) < 40:
        raise ValueError(f"有效樣本僅 {len(y)} 筆（<40），不足以訓練時序模型")
    test_size = min(0.5, max(0.05, float((rec.get("ts") or {}).get("test_size") or 0.2)))
    n_te = min(len(y) // 2, max(8, int(len(y) * test_size)))
    ytr, yte = y[:-n_te], y[-n_te:]
    fc, fitted = _ts_forecast(rec["algo"], rec.get("params"), ytr, n_te)
    rec["metrics_cv"] = _metrics(yte, fc)
    rec["val_desc"] = f"尾端保留 {int(test_size * 100)}%（外推 {n_te} 筆）"
    if fitted is not None and len(fitted) > 0:
        k = len(ytr) - len(fitted)  # AR 類前 lags 筆無 fitted
        skip = max(5, k)            # 差分/初始化模型前幾筆 fitted 不可靠，一律跳過
        rec["metrics_train"] = _metrics(ytr[skip:], fitted[skip - k:])
    else:
        rec["metrics_train"] = _metrics(ytr[1:], ytr[:-1])  # 基準模型：一階遞延
    # 時序疊圖：訓練尾段脈絡＋測試段實際 vs 外推
    n_hist = min(3 * n_te, 600, len(ytr))
    rec["plots"] = {"tsf": {
        "t_hist": t[len(ytr) - n_hist:len(ytr)].tolist(),
        "y_hist": np.round(ytr[-n_hist:], 4).tolist(),
        "t_test": t[-n_te:].tolist(),
        "y_test": np.round(yte, 4).tolist(),
        "pred": np.round(fc, 4).tolist(),
    }}
    rec["n_rows"] = int(len(y))
    rec["status"] = "done"


def _train_job(sid: str, rec: dict):
    """背景訓練：使用者選定的驗證方法＋訓練集指標＋圖資料＋permutation importance＋joblib 持久化。"""
    try:
        import joblib
        from sklearn.inspection import permutation_importance
        from sklearn.model_selection import RandomizedSearchCV

        task = rec.get("task", "regression")
        if task == "timeseries":
            _run_ts(sid, rec)
            _save(sid, rec)
            return
        if task == "anomaly":
            _run_anomaly(sid, rec)
            _save(sid, rec)
            return
        if task == "hybrid":
            _run_hybrid(sid, rec)
            _save(sid, rec)
            return

        cls = task == "classification"
        X, y = _current_xy(sid, rec)
        if len(y) < 30:
            raise ValueError(f"有效樣本僅 {len(y)} 筆（<30），不足以訓練")
        if cls and len(set(y)) < 2:
            raise ValueError("分類目標只有一個類別")

        pipe = _build_pipeline(rec["algo"], rec.get("params"), task)
        if rec.get("auto_tune") and rec["algo"] in TUNE_SPACE:
            scoring = "f1_macro" if cls else "neg_root_mean_squared_error"
            space = {k: v for k, v in TUNE_SPACE[rec["algo"]].items()
                     if k.replace("model__", "") in {pp["key"] for pp in ALGOS[rec["algo"]]["params"]}
                     or k.startswith("spline__") or k == "model__hidden_layer_sizes"}
            try:
                search = RandomizedSearchCV(pipe, space, n_iter=8, cv=3,
                                            scoring=scoring, random_state=0, n_jobs=1)
                search.fit(X, y)
                pipe = search.best_estimator_
                rec["tuned_params"] = {k.replace("model__", "").replace("spline__", ""):
                                       (list(v) if isinstance(v, tuple) else v)
                                       for k, v in search.best_params_.items()}
            except Exception:  # noqa: BLE001 分類器參數名不合時退回預設
                pipe = _build_pipeline(rec["algo"], rec.get("params"), task)

        # 驗證（使用者可選：K 折／保留法／時序切分）
        cfg = _validation_cfg(rec)
        y_val, yhat_val, desc = _validate_tabular(pipe, X, y, cls, cfg)
        rec["metrics_cv"] = _metrics_cls(y_val, yhat_val) if cls else _metrics(y_val, yhat_val)
        rec["val_desc"] = desc
        pipe.fit(X, y)
        rec["metrics_train"] = _metrics_cls(y, pipe.predict(X)) if cls else _metrics(y, np.ravel(pipe.predict(X)))

        rec["plots"] = {}
        if cls:
            from sklearn.metrics import confusion_matrix
            labels = sorted(set(list(y_val) + list(yhat_val)))
            cm = confusion_matrix(y_val, yhat_val, labels=labels)
            rec["plots"]["cm"] = {"labels": [str(l) for l in labels], "matrix": cm.tolist()}
        else:
            y_val = np.asarray(y_val, float).ravel()
            yhat_val = np.asarray(yhat_val, float).ravel()
            idx = np.random.RandomState(0).choice(len(y_val), min(600, len(y_val)), replace=False)
            rec["plots"]["pa"] = {"actual": np.round(y_val[idx], 4).tolist(),
                                  "pred": np.round(yhat_val[idx], 4).tolist()}
            rec["plots"]["err"] = {"actual": np.round(y_val[idx], 4).tolist(),
                                   "error": np.round((y_val - yhat_val)[idx], 4).tolist()}
        sub = np.random.RandomState(0).choice(len(y), min(1500, len(y)), replace=False)
        imp = permutation_importance(pipe, X[sub], y[sub], n_repeats=5, random_state=0, n_jobs=1,
                                     scoring="f1_macro" if cls else None)
        order = np.argsort(imp.importances_mean)[::-1][:15]
        rec["plots"]["fi"] = {"names": [rec["features"][i] for i in order],
                              "values": np.round(imp.importances_mean[order], 5).tolist()}
        rec["n_rows"] = int(len(y))
        joblib.dump(pipe, _pipe_path(sid, rec["id"]))
        rec["status"] = "done"
    except Exception as e:  # noqa: BLE001
        rec["status"] = "error"
        rec["error"] = str(e)[:300]
    _save(sid, rec)


# ------------------------------------------------------ API
@router.get("/algos")
def algos() -> dict:
    return {"algos": [{"key": k, "name": v["name"], "params": v["params"],
                       "tasks": v["tasks"], "tunable": k in TUNE_SPACE,
                       "desc": v.get("desc", "")}
                      for k, v in ALGOS.items()]}


@router.get("/{sid}/models")
def list_models(sid: str) -> list:
    out = []
    for p in sorted(_mdir(sid).glob("*.json")):
        r = json.loads(p.read_text(encoding="utf-8"))
        out.append({k: r.get(k) for k in
                    ("id", "name", "target", "algo", "task", "status", "created",
                     "metrics_cv", "error", "auto_tune")})
    # 排名：迴歸依 CV RMSE、分類依 1−accuracy（完成者優先）
    def _rank(r):
        m = r.get("metrics_cv") or {}
        score = m.get("rmse", 1 - m.get("accuracy", -1e18))
        return (r["status"] != "done", score)
    out.sort(key=_rank)
    return out


@router.get("/{sid}/models/{mid}")
def get_model(sid: str, mid: str) -> dict:
    return _load(sid, mid)


@router.delete("/{sid}/models/{mid}")
def delete_model(sid: str, mid: str) -> dict:
    _mpath(sid, mid).unlink(missing_ok=True)
    _pipe_path(sid, mid).unlink(missing_ok=True)
    (_mdir(sid) / f"{mid}_batch.csv").unlink(missing_ok=True)
    return {"ok": True}


@router.post("/{sid}/models/{mid}/rename")
def rename_model(sid: str, mid: str, body: dict) -> dict:
    name = (body.get("name") or "").strip()
    if not name or len(name) > 60:
        raise HTTPException(422, "模型名稱需為 1–60 字")
    rec = _load(sid, mid)
    rec["name"] = name
    _save(sid, rec)
    return {"ok": True, "name": name}


@router.post("/{sid}/models")
def create_models(sid: str, body: dict) -> dict:
    """手動：單一演算法；全自動：九式各建一個（= Tukey 一次性建立多個模型）。
    任務自動判定：目標欄數值＝迴歸、字串/類別＝分類。"""
    target = body.get("target")
    features = [f for f in body.get("features", []) if f != target]
    is_anomaly = body.get("task_type") == "anomaly"
    if is_anomaly:
        # 異常偵測＝無監督：不需目標，只要監測欄位
        if len(features) < 2:
            raise HTTPException(422, "異常偵測至少需要兩個監測欄位")
        target = target or "（無監督）"
    elif not target or not features:
        raise HTTPException(422, "需要 target 與至少一個自變數")
    df = _load_base(sid)
    view, *_ = apply_steps(df, _load_steps(sid))
    if is_anomaly:
        task = "anomaly"
    else:
        if target not in view.columns:
            raise HTTPException(422, f"目標欄 {target} 不存在")
        task = "regression" if pd.api.types.is_numeric_dtype(view[target]) else "classification"
    ts_cfg = None
    if body.get("task_type") == "timeseries":
        if task != "regression":
            raise HTTPException(422, "時序預測的目標必須是數值欄")
        tcols = [c for c in view.columns if pd.api.types.is_datetime64_any_dtype(view[c])]
        if not tcols:
            raise HTTPException(422, "時序預測需要時間欄")
        task = "timeseries"
        ts_cfg = {"time_col": body.get("time_col") or tcols[0],
                  "test_size": min(0.5, max(0.05, float(body.get("test_size") or 0.2)))}
    sim_col = None
    if body.get("task_type") == "hybrid":
        if task != "regression":
            raise HTTPException(422, "混合模型的目標必須是數值欄")
        sim_col = body.get("sim_col")
        if not sim_col or sim_col not in view.columns:
            raise HTTPException(422, "混合模型需要指定模擬基準欄（如 ASPEN 模擬產出欄）")
        if not pd.api.types.is_numeric_dtype(pd.to_numeric(view[sim_col], errors="coerce")):
            raise HTTPException(422, f"模擬基準欄 {sim_col} 必須是數值欄")
        task = "hybrid"
        features = [f for f in features if f != sim_col]
        if not features:
            raise HTTPException(422, "混合模型至少需要一個自變數（不含模擬基準欄）")
    validation = body.get("validation") or {}
    mode = body.get("mode", "manual")
    jobs = []
    # 混合模型的 g/r 都是迴歸管線 → 用迴歸演算法集
    algo_task = "regression" if task == "hybrid" else task
    task_algos = [k for k, v in ALGOS.items() if algo_task in v["tasks"]]
    if mode == "auto":
        for algo in task_algos:
            jobs.append({"algo": algo, "name": f"{body.get('name') or target}_{algo}",
                         "params": {}, "auto_tune": task not in ("timeseries", "hybrid")})
    else:
        algo = body.get("algo", "XGB")
        if algo not in ALGOS:
            raise HTTPException(422, f"未知演算法 {algo}")
        if algo_task not in ALGOS[algo]["tasks"]:
            raise HTTPException(422, f"{ALGOS[algo]['name']} 不支援{task}任務")
        jobs.append({"algo": algo, "name": body.get("name") or f"{target}_{algo}",
                     "params": body.get("params") or {},
                     "auto_tune": bool(body.get("auto_tune")) and task != "hybrid"})

    created = []
    for j in jobs:
        rec = {"id": uuid.uuid4().hex[:8], "sid": sid, "status": "training",
               "created": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
               "target": target, "features": features, "task": task, **j}
        if ts_cfg:
            rec["ts"] = ts_cfg
        if sim_col:
            rec["sim_col"] = sim_col
        if validation:
            rec["validation"] = validation
        _save(sid, rec)
        created.append(rec["id"])

    def run_all(ids=tuple(created)):
        for mid in ids:  # 逐一訓練避免 CPU 風暴
            _train_job(sid, _load(sid, mid))

    threading.Thread(target=run_all, daemon=True).start()
    return {"created": created, "count": len(created)}


# ------------------------------------------------------ 模型應用（Tukey 對齊，除 API 啟用管理）
@router.post("/{sid}/models/{mid}/evaluate")
def evaluate(sid: str, mid: str) -> dict:
    """單一模型評估（隨選）：以現行視圖重評——視圖若已變（新步驟/新資料），
    這就是模型在「現在這份資料」上的表現。"""
    rec = _load(sid, mid)
    if rec.get("status") != "done":
        raise HTTPException(422, "模型尚未完成訓練")
    cls = rec.get("task") == "classification"
    if rec.get("task") == "anomaly":
        # 異常評估＝已訓練基準對「現行視圖」計算風險值（監控新資料）
        import joblib
        pack = joblib.load(_pipe_path(sid, mid)) if _pipe_path(sid, mid).exists() else None
        if not pack:
            raise HTTPException(422, "此模型未保存訓練成品——請重新訓練")
        X, t, _has_time = _anomaly_xt(sid, rec)
        if len(X) < 5:
            raise HTTPException(422, f"現行視圖有效樣本僅 {len(X)} 筆，無法評估")
        risk = np.asarray(_anomaly_score(rec["algo"], pack["meta"], X), float)
        thr = float((rec.get("metrics_cv") or {}).get("threshold") or THRESH_METHODS["p99"][1](risk))
        health = _health_from_risk(risk, thr)
        mu = np.asarray(pack.get("mu") or X.mean(axis=0), float)
        sd = np.maximum(np.asarray(pack.get("sd") or X.std(axis=0), float), 1e-9)
        events = _anomaly_events(risk, thr, t, X, rec["features"], mu, sd)
        n_tail = max(5, len(health) // 20)
        step = max(1, len(risk) // 900)
        ev = {"evaluated_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
              "n_rows": int(len(X)),
              "metrics": {"health_now": round(float(health[-n_tail:].mean()), 1),
                          "threshold": round(thr, 5),
                          "exceed_pct": round(float((risk > thr).mean()) * 100, 3),
                          "n_events": len(events)},
              "risk": {"t": t[::step].tolist(), "risk": np.round(risk[::step], 5).tolist(),
                       "threshold": round(thr, 5)},
              "health": {"t": t[::step].tolist(), "score": np.round(health[::step], 1).tolist()},
              "events": events}
        rec["evaluation"] = ev
        _save(sid, rec)
        return ev
    if rec.get("task") == "timeseries":
        # 時序評估＝在「現行視圖」重跑尾端保留（重擬合＋外推）
        y, t = _ts_series(sid, rec)
        if len(y) < 40:
            raise HTTPException(422, f"現行視圖有效樣本僅 {len(y)} 筆，無法評估")
        test_size = min(0.5, max(0.05, float((rec.get("ts") or {}).get("test_size") or 0.2)))
        n_te = min(len(y) // 2, max(8, int(len(y) * test_size)))
        ytr, yte = y[:-n_te], y[-n_te:]
        fc, _fitted = _ts_forecast(rec["algo"], rec.get("params"), ytr, n_te)
        n_hist = min(3 * n_te, 600, len(ytr))
        ev = {"evaluated_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
              "n_rows": int(len(y)), "metrics": _metrics(yte, fc),
              "tsf": {"t_hist": t[len(ytr) - n_hist:len(ytr)].tolist(),
                      "y_hist": np.round(ytr[-n_hist:], 4).tolist(),
                      "t_test": t[-n_te:].tolist(),
                      "y_test": np.round(yte, 4).tolist(),
                      "pred": np.round(fc, 4).tolist()}}
        rec["evaluation"] = ev
        _save(sid, rec)
        return ev
    pipe = _load_pipe(sid, mid)
    X, y = _current_xy(sid, rec)
    if len(y) < 5:
        raise HTTPException(422, f"現行視圖有效樣本僅 {len(y)} 筆，無法評估")
    yhat = np.ravel(_predict_any(pipe, X)) if not cls else pipe.predict(X)
    ev = {"evaluated_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
          "n_rows": int(len(y)),
          "metrics": _metrics_cls(y, yhat) if cls else _metrics(y, yhat)}
    if cls:
        from sklearn.metrics import confusion_matrix
        labels = sorted(set(list(y) + list(yhat)))
        ev["cm"] = {"labels": [str(l) for l in labels],
                    "matrix": confusion_matrix(y, yhat, labels=labels).tolist()}
    else:
        idx = np.random.RandomState(0).choice(len(y), min(600, len(y)), replace=False)
        ev["pa"] = {"actual": np.round(y[idx].astype(float), 4).tolist(),
                    "pred": np.round(yhat[idx].astype(float), 4).tolist()}
    rec["evaluation"] = ev
    _save(sid, rec)
    return ev


@router.post("/{sid}/models/{mid}/threshold")
def threshold(sid: str, mid: str, body: dict) -> dict:
    """風險值門檻試算：對異常偵測模型以指定方法計算合理門檻，回門檻＋超標統計。"""
    rec = _load(sid, mid)
    if rec.get("task") != "anomaly":
        raise HTTPException(422, "門檻試算僅適用異常偵測模型")
    import joblib
    pack = joblib.load(_pipe_path(sid, mid)) if _pipe_path(sid, mid).exists() else None
    if not pack:
        raise HTTPException(422, "此模型未保存訓練成品——請重新訓練")
    method = body.get("method", "p99")
    if method not in THRESH_METHODS:
        raise HTTPException(422, f"未知門檻方法 {method}")
    X, t, has_time = _anomaly_xt(sid, rec)
    risk = np.asarray(_anomaly_score(rec["algo"], pack["meta"], X), float)
    name, fn = THRESH_METHODS[method]
    thr = fn(risk)
    exceed = risk > thr
    # 套用：更新模型建議門檻，並重算健康分數/事件/7 天預測（皆依門檻定義）
    if body.get("apply"):
        health = _health_from_risk(risk, thr)
        mu = np.asarray(pack.get("mu") or X.mean(axis=0), float)
        sd = np.maximum(np.asarray(pack.get("sd") or X.std(axis=0), float), 1e-9)
        events = _anomaly_events(risk, thr, t, X, rec["features"], mu, sd)
        pred = _health_forecast(t, health, has_time)
        n_tail = max(5, len(health) // 20)
        rec["metrics_cv"] = {"health_now": round(float(health[-n_tail:].mean()), 1),
                             "threshold": round(thr, 5),
                             "exceed_pct": round(float(exceed.mean()) * 100, 3),
                             "n_events": len(events),
                             "health_7d": pred["day7"] if pred else None}
        rec["metrics_train"] = rec["metrics_cv"]
        rec["events"] = events
        step = max(1, len(risk) // 900)
        plots = rec.get("plots") or {}
        plots["risk"] = {"t": t[::step].tolist(), "risk": np.round(risk[::step], 5).tolist(),
                         "threshold": round(thr, 5)}
        plots["health"] = {"t": t[::step].tolist(), "score": np.round(health[::step], 1).tolist()}
        plots["health_pred"] = pred
        rec["plots"] = plots
        rec["val_desc"] = f"健康基準＝現行視圖；門檻＝{name}"
        _save(sid, rec)
    return {"method": method, "method_name": name, "threshold": round(thr, 5),
            "n_rows": int(len(risk)), "exceed": int(exceed.sum()),
            "exceed_pct": round(float(exceed.mean()) * 100, 3), "applied": bool(body.get("apply"))}


def _batch_time_col(df: pd.DataFrame, skip: set):
    """測試資料集的時間欄偵測：datetime dtype 或 ≥90% 可解析的字串欄。"""
    for c in df.columns:
        if c in skip:
            continue
        if pd.api.types.is_datetime64_any_dtype(df[c]):
            return c, df[c]
        if pd.api.types.is_string_dtype(df[c]) or df[c].dtype == object:
            parsed = pd.to_datetime(df[c], errors="coerce")
            if parsed.notna().mean() >= 0.9:
                return c, parsed
    return None, None


@router.post("/{sid}/models/{mid}/batch")
async def batch_calc(sid: str, mid: str, file: UploadFile = File(...)) -> dict:
    """批次試算（品質結果試算）：上傳新測試資料集，以已訓練模型整批預測。
    上傳檔含目標欄時併算實際 vs 預測；結果檔（原欄＋預測欄）可下載。"""
    rec = _load(sid, mid)
    if rec.get("task") not in ("regression", "classification", "hybrid"):
        raise HTTPException(422, "批次試算僅支援迴歸／分類／混合模型")
    pipe = _load_pipe(sid, mid)
    raw = await file.read()
    if len(raw) > 50 * 1024 * 1024:
        raise HTTPException(422, "檔案過大（>50MB）")
    fname = file.filename or "upload"
    try:
        if fname.lower().endswith((".xlsx", ".xls", ".xlsm")):
            df = pd.read_excel(io.BytesIO(raw))
        else:
            df = pd.read_csv(io.BytesIO(raw), encoding="utf-8-sig")
    except Exception as e:  # noqa: BLE001
        raise HTTPException(422, f"測試資料解析失敗（{type(e).__name__}）") from None
    missing = [c for c in rec["features"] if c not in df.columns]
    if missing:
        raise HTTPException(422, f"測試資料缺少模型特徵欄：{missing}")
    cls = rec.get("task") == "classification"
    feats = df[rec["features"]].apply(pd.to_numeric, errors="coerce")
    ok = feats.notna().all(axis=1)
    if not ok.any():
        raise HTTPException(422, "沒有任何一列的特徵值完整可預測（檢查數值格式）")
    X = feats[ok].to_numpy(dtype=float)
    yhat = pipe.predict(X) if cls else _predict_any(pipe, X)
    yhat = np.asarray(yhat) if cls else np.ravel(yhat).astype(float)
    # 結果檔＝原欄位＋預測欄
    pred_col = f"{rec['target']}_預測值"
    out = df.copy()
    out[pred_col] = None if cls else np.nan
    out.loc[ok, pred_col] = yhat
    out.to_csv(_mdir(sid) / f"{mid}_batch.csv", index=False, encoding="utf-8-sig")
    # 實際值（上傳檔含目標欄）→ 指標
    metrics = cm = None
    actual = None
    if rec["target"] in df.columns:
        if cls:
            a = df.loc[ok, rec["target"]]
            valid = a.notna().to_numpy()
            if valid.any():
                y_true = np.asarray(a[a.notna()].astype(str).tolist(), dtype=object)
                y_pred = yhat[valid]
                metrics = _metrics_cls(y_true, y_pred)
                from sklearn.metrics import confusion_matrix
                labels = sorted(set(list(y_true) + list(y_pred)))
                cm = {"labels": [str(l) for l in labels],
                      "matrix": confusion_matrix(y_true, y_pred, labels=labels).tolist()}
        else:
            a = pd.to_numeric(df.loc[ok, rec["target"]], errors="coerce")
            valid = a.notna().to_numpy()
            if valid.any():
                metrics = _metrics(a.to_numpy(dtype=float)[valid], yhat[valid])
                actual = a.to_numpy(dtype=float)
    # 時間欄（實際 vs 預測隨時間圖）
    tcol, tparsed = _batch_time_col(df, set(rec["features"]) | {rec["target"]})
    t = None
    if tcol is not None:
        tv = ((tparsed - pd.Timestamp(0)) / pd.Timedelta(seconds=1))[ok]
        t = tv.to_numpy(dtype=float)
    # 抽樣圖資（≤600 點；有時間依時間排序）
    n = int(ok.sum())
    order = np.argsort(t) if t is not None else np.arange(n)
    step = max(1, n // 600)
    sel = order[::step]
    sample = {"pred": [None if (isinstance(v, float) and np.isnan(v)) else
                       (str(v) if cls else round(float(v), 5)) for v in yhat[sel]]}
    if t is not None:
        sample["t"] = np.round(t[sel], 1).tolist()
    if actual is not None:
        sample["actual"] = [None if np.isnan(v) else round(float(v), 5) for v in actual[sel]]
    if not cls:
        sample["cols"] = {f: np.round(X[sel, i], 5).tolist() for i, f in enumerate(rec["features"])}
    # 結果預覽（前 20 列）
    prev_cols = ([tcol] if tcol else []) + [pred_col] + \
                ([rec["target"]] if rec["target"] in df.columns else []) + rec["features"]
    prev = out.loc[ok, prev_cols].head(20)
    preview = {"cols": prev_cols,
               "rows": [[("" if pd.isna(v) else (round(v, 5) if isinstance(v, float) else str(v)))
                         for v in row] for row in prev.itertuples(index=False)]}
    batch = {"at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"), "filename": fname,
             "n_rows": int(len(df)), "n_pred": n, "metrics": metrics, "cm": cm,
             "sample": sample, "preview": preview, "time_col": tcol}
    rec["batch"] = batch
    _save(sid, rec)
    return batch


@router.get("/{sid}/models/{mid}/batch/download")
def batch_download(sid: str, mid: str):
    p = _mdir(sid) / f"{mid}_batch.csv"
    if not p.exists():
        raise HTTPException(404, "尚無批次試算結果——請先執行批次試算")
    rec = _load(sid, mid)
    return FileResponse(p, filename=f"{rec.get('name', mid)}_批次試算結果.csv",
                        media_type="text/csv")


@router.post("/{sid}/models/{mid}/whatif")
def whatif(sid: str, mid: str, body: dict) -> dict:
    """操作差異試算：baseline＝現行視圖特徵中位數，body.values 覆蓋部分特徵。"""
    rec = _load(sid, mid)
    if rec.get("task") not in ("regression", "classification", "hybrid"):
        raise HTTPException(422, "操作差異試算僅支援迴歸／分類／混合模型")
    pipe = _load_pipe(sid, mid)
    base = _baseline(sid, rec)
    values = body.get("values") or {}
    row = dict(base)
    for k, v in values.items():
        if k in row and v is not None and v != "":
            row[k] = float(v)
    Xb = np.array([[base[f] for f in rec["features"]]])
    Xn = np.array([[row[f] for f in rec["features"]]])
    if rec.get("task") == "classification":
        pb, pn = str(pipe.predict(Xb)[0]), str(pipe.predict(Xn)[0])
        out = {"baseline_pred": pb, "pred": pn, "changed": pb != pn, "baseline": base}
        if hasattr(pipe, "predict_proba"):
            proba = pipe.predict_proba(Xn)[0]
            classes = [str(c) for c in pipe.classes_]
            out["proba"] = {c: round(float(p), 4) for c, p in
                            sorted(zip(classes, proba), key=lambda t: -t[1])[:5]}
        return out
    pb = float(np.ravel(_predict_any(pipe, Xb))[0])
    pn = float(np.ravel(_predict_any(pipe, Xn))[0])
    return {"baseline_pred": round(pb, 5), "pred": round(pn, 5),
            "delta": round(pn - pb, 5), "baseline": base}


@router.post("/{sid}/models/{mid}/optimize")
def optimize(sid: str, mid: str, body: dict) -> dict:
    """配方優化（參數最佳化）：目標值/最大化/最小化，輸出最佳參數建議。
    可調參數邊界＝現行視圖 P1–P99；隨機搜尋＋最佳鄰域細化。僅迴歸。"""
    rec = _load(sid, mid)
    if rec.get("task") not in ("regression", "hybrid"):
        raise HTTPException(422, "配方優化僅支援迴歸／混合模型")
    pipe = _load_pipe(sid, mid)
    mode = body.get("mode", "target")
    knobs = [k for k in (body.get("knobs") or rec["features"]) if k in rec["features"]]
    if not knobs:
        raise HTTPException(422, "至少選一個可調參數")
    if mode == "target" and body.get("value") in (None, ""):
        raise HTTPException(422, "target 模式需要目標值")

    X, _ = _current_xy(sid, rec)
    base = _baseline(sid, rec)
    lo = {f: float(np.percentile(X[:, i], 1)) for i, f in enumerate(rec["features"])}
    hi = {f: float(np.percentile(X[:, i], 99)) for i, f in enumerate(rec["features"])}
    rng = np.random.RandomState(0)
    kidx = [rec["features"].index(k) for k in knobs]

    def make(n, center=None, spread=1.0):
        pts = np.tile([base[f] for f in rec["features"]], (n, 1))
        for j, i in enumerate(kidx):
            f = rec["features"][i]
            if center is None:
                pts[:, i] = rng.uniform(lo[f], hi[f], n)
            else:
                span = (hi[f] - lo[f]) * 0.08 * spread
                pts[:, i] = np.clip(rng.normal(center[j], span or 1e-9, n), lo[f], hi[f])
        return pts

    def score(preds):
        if mode == "max":
            return -preds
        if mode == "min":
            return preds
        return np.abs(preds - float(body["value"]))

    cand = make(3000)
    preds = np.ravel(_predict_any(pipe, cand))
    order = np.argsort(score(preds))
    # 最佳 50 組鄰域細化一輪
    refined = np.vstack([make(40, center=cand[i, kidx], spread=1.0) for i in order[:50]])
    preds2 = np.ravel(_predict_any(pipe, refined))
    all_pts = np.vstack([cand, refined])
    all_preds = np.concatenate([preds, preds2])
    best_i = int(np.argmin(score(all_preds)))
    best_pt = all_pts[best_i]

    baseline_pred = float(np.ravel(_predict_any(pipe, np.array([[base[f] for f in rec["features"]]])))[0])
    return {
        "mode": mode, "value": body.get("value"),
        "best": {rec["features"][i]: round(float(best_pt[i]), 5) for i in kidx},
        "baseline": {k: base[k] for k in knobs},
        "bounds": {k: [round(lo[k], 5), round(hi[k], 5)] for k in knobs},
        "pred": round(float(all_preds[best_i]), 5),
        "baseline_pred": round(baseline_pred, 5),
    }


# ------------------------------------------------------ 多目標配方最佳化（optimize2）
# 設計＝三份獨立設計合成＋對抗批判修正（Derringer–Suich desirability 正規化、
# range 硬約束＋軟斜坡並用、欄名對齊防靜默錯位、貪婪最遠點去重）。
# 批判修正全部內建：①錨點用現行視圖 y 的 P1-P99（非不存在的訓練 y）②range 軟斜坡
# 分母加 1e-9 下限＋界外歸零＋nan_to_num ③單輪細化（不做語意未閉合的多輪）
# ④驗證順序固定 ⑤去重距離分母加下限。
OPT2_BUDGET = {"low": {"n": 1500, "M": 20, "K": 25},
               "med": {"n": 3000, "M": 50, "K": 40},
               "high": {"n": 8000, "M": 100, "K": 60}}


def _desirability(p: np.ndarray, ctype: str, lo: float, hi: float,
                  rmin: float = None, rmax: float = None) -> np.ndarray:
    """單目標無量綱慾望度 d∈[0,1]（越大越好）。lo/hi=正規化錨點（現行視圖 y P1-P99）。"""
    span = hi - lo
    if span < 1e-9:               # 常數目標：不影響排序
        return np.ones_like(p, dtype=float)
    if ctype == "max":
        d = np.clip((p - lo) / span, 0, 1)
    elif ctype == "min":
        d = np.clip((hi - p) / span, 0, 1)
    else:                          # range：區間內=1，兩側軟斜坡（分母下限＋界外歸零）
        d = np.ones_like(p, dtype=float)
        left = p < rmin
        if rmin <= lo:            # 左界貼齊/超出錨點：界外無梯度空間→歸零
            d[left] = 0.0
        else:
            d[left] = np.clip((p[left] - lo) / max(rmin - lo, 1e-9), 0, 1)
        right = p > rmax
        if rmax >= hi:
            d[right] = 0.0
        else:
            d[right] = np.clip((hi - p[right]) / max(hi - rmax, 1e-9), 0, 1)
    return np.nan_to_num(d, nan=0.0, posinf=0.0, neginf=0.0)


@router.post("/{sid}/optimize2")
def optimize2(sid: str, body: dict) -> dict:
    """多目標配方最佳化：多個模型當目標（各帶範圍/最大/最小條件＋權重）、
    可調參數自訂搜尋範圍、其餘特徵起始值、精準度→輸出推薦參數組合。"""
    # ── 步驟 1：純語法驗證 ─────────────────────────────
    objectives = body.get("objectives") or []
    knobs_in = body.get("knobs") or []
    if not objectives:
        raise HTTPException(422, "至少需要一個最佳化目標")
    if not knobs_in:
        raise HTTPException(422, "至少需要一個最佳化參數")
    if len(objectives) > 8:
        raise HTTPException(422, "最佳化目標最多 8 個")
    weights = []
    for o in objectives:
        if not o.get("mid"):
            raise HTTPException(422, "每個目標都需要指定模型")
        cond = o.get("condition") or {}
        ct = cond.get("type", "max")
        if ct not in ("range", "max", "min"):
            raise HTTPException(422, f"未知的目標條件 {ct}")
        if ct == "range":
            if cond.get("min") is None or cond.get("max") is None:
                raise HTTPException(422, "範圍條件需要 min 與 max")
            if float(cond["min"]) >= float(cond["max"]):
                raise HTTPException(422, "範圍條件的 min 須小於 max")
        w = float(o.get("weight", 1.0))
        if w < 0:
            raise HTTPException(422, "權重須為正數")
        weights.append(w)
    warning = None
    if sum(weights) <= 0:
        weights = [1.0] * len(objectives)
        warning = "所有權重為 0，已改用等權重"
    knob_names = []
    knob_range = {}
    for k in knobs_in:
        nm = k.get("name")
        if not nm:
            raise HTTPException(422, "每個最佳化參數都需要名稱")
        knob_names.append(nm)
        if k.get("lo") is not None and k.get("hi") is not None:
            if float(k["lo"]) >= float(k["hi"]):
                raise HTTPException(422, f"參數 {nm} 的範圍 min 須小於 max")
            knob_range[nm] = [float(k["lo"]), float(k["hi"])]

    # ── 步驟 2：逐目標載入、擋非迴歸、驗缺欄 ──────────────
    import joblib
    recs, packs, yscale = [], [], []
    for o in objectives:
        rec = _load(sid, o["mid"])
        if rec.get("task") not in ("regression", "hybrid"):
            raise HTTPException(422, f"目標「{rec.get('name') or o['mid']}」是 {rec.get('task')} 模型，"
                                     "配方最佳化僅支援迴歸／混合模型")
        Xk, yk = _current_xy(sid, rec)      # 缺欄會 422；y 供正規化錨點
        if len(yk) == 0:
            raise HTTPException(422, f"目標「{rec.get('name') or o['mid']}」在現行資料視圖沒有可用資料列"
                                     "（可能被篩選步驟全部排除），無法最佳化")
        p1, p99 = float(np.percentile(yk, 1)), float(np.percentile(yk, 99))
        yscale.append([p1, p99])
        recs.append(rec)
        packs.append(joblib.load(_pipe_path(sid, o["mid"])) if _pipe_path(sid, o["mid"]).exists()
                     else _load_pipe(sid, o["mid"]))

    # ── 步驟 3：建共同搜尋空間 U、ucol、中位數/起始值 ────────
    U = sorted(set().union(*[r["features"] for r in recs]))
    ucol = {name: j for j, name in enumerate(U)}
    if len(U) > 30:
        raise HTTPException(422, f"目標模型的特徵聯集共 {len(U)} 欄（上限 30）")
    median_map = {}
    for rec in recs:
        for f, v in _baseline(sid, rec).items():
            median_map.setdefault(f, v)
    reference = dict(median_map)
    for f, v in (body.get("reference") or {}).items():
        if f in ucol and v is not None and v != "":
            reference[f] = float(v)

    # ── 步驟 4：驗 knob∈U、範圍非常數 ─────────────────
    for nm in knob_names:
        if nm not in ucol:
            raise HTTPException(422, f"參數 {nm} 不屬於任何目標模型的特徵")
        if nm not in knob_range:            # 未給範圍→退回現行視圖 P1-P99
            col = np.array([median_map.get(nm, 0.0)])
            # 從第一個含此特徵的模型視圖取分位數
            for rec in recs:
                if nm in rec["features"]:
                    Xk, _ = _current_xy(sid, rec)
                    col = Xk[:, rec["features"].index(nm)]
                    break
            lo_k, hi_k = float(np.percentile(col, 1)), float(np.percentile(col, 99))
            if hi_k - lo_k < 1e-9:
                raise HTTPException(422, f"參數 {nm} 在現行視圖幾乎無變化，無法作為可調參數（請指定範圍）")
            knob_range[nm] = [lo_k, hi_k]

    prec = body.get("precision", "med")
    B = OPT2_BUDGET.get(prec, OPT2_BUDGET["med"])
    n, M, K = B["n"], B["M"], B["K"]
    top_n = int(body.get("top_n") or 5)
    top_n = max(1, min(10, top_n))
    seed = int(body.get("seed") or 0)
    rng = np.random.RandomState(seed)
    kidx = [ucol[nm] for nm in knob_names]

    # ── 步驟 5：取樣＋評分 helper ─────────────────────
    ref_row = np.array([reference.get(U[j], median_map.get(U[j], 0.0)) for j in range(len(U))], float)

    def sample(m, centers=None, spread=1.0):
        pts = np.tile(ref_row, (m, 1))
        for nm, j in zip(knob_names, kidx):
            lo_k, hi_k = knob_range[nm]
            if centers is None:
                pts[:, j] = rng.uniform(lo_k, hi_k, m)
            else:
                sp = (hi_k - lo_k) * 0.08 * spread
                pts[:, j] = np.clip(rng.normal(centers[nm], sp or 1e-9, m), lo_k, hi_k)
        return pts

    def evaluate(S):
        """回 (preds_by_obj[list of arr], d_by_obj[list], score[arr], feasible[bool arr], nviol[arr])."""
        preds_by, d_by = [], []
        feas = np.ones(len(S), bool)
        nviol = np.zeros(len(S), int)
        for i, rec in enumerate(recs):
            Xk = S[:, [ucol[f] for f in rec["features"]]]
            p = np.ravel(_predict_any(packs[i], Xk)).astype(float)
            valid = np.isfinite(p)           # 模型外插出 NaN/inf 的點：無效
            p = np.nan_to_num(p, nan=0.0, posinf=0.0, neginf=0.0)
            preds_by.append(p)
            cond = objectives[i].get("condition") or {}
            ct = cond.get("type", "max")
            lo_k, hi_k = yscale[i]            # 常數錨點交由 _desirability 回常數 1.0（勿用本批 min/max，
                                             # 否則 baseline 單點與 pool 多點錨點不一致、分數不可比）
            rmin = float(cond["min"]) if ct == "range" else None
            rmax = float(cond["max"]) if ct == "range" else None
            d = _desirability(p, ct, lo_k, hi_k, rmin, rmax)
            d[~valid] = 0.0                   # 無效點慾望度歸零
            d_by.append(d)
            feas &= valid                     # 任一目標預測無效 → 該點不可行
            if ct == "range":
                ok = (p > rmin) & (p < rmax) & valid
                nviol += (~ok).astype(int)
                feas &= ok
        wsum = sum(weights)
        score = np.zeros(len(S))
        for i in range(len(recs)):
            score += (weights[i] / wsum) * d_by[i]
        return preds_by, d_by, score, feas, nviol

    # 初始取樣 → 細化（單輪，top-M 鄰域）→ 併池
    S = sample(n)
    _, _, sc, _, _ = evaluate(S)
    order = np.argsort(-sc)[:M]
    refined = np.vstack([sample(K, centers={nm: S[i, ucol[nm]] for nm in knob_names})
                         for i in order]) if M else np.empty((0, len(U)))
    pool = np.vstack([S, refined]) if len(refined) else S
    preds_by, d_by, score, feas, nviol = evaluate(pool)

    # ── 步驟 6：選 top-N（feasible 優先，貪婪最遠點去重）────
    feasible_any = bool(feas.any())
    if feasible_any:
        cand = np.where(feas)[0]
        cand = cand[np.argsort(-score[cand])]
    else:                                   # 無可行解：先比違反數、再比分數
        cand = np.lexsort((-score, nviol))

    # 去重距離（knob 空間正規化，分母加下限）
    kspan = np.array([max(knob_range[nm][1] - knob_range[nm][0], 1e-9) for nm in knob_names])

    def kvec(i):
        return np.array([pool[i, ucol[nm]] for nm in knob_names])
    picked, tau = [], 0.15
    while len(picked) < top_n and tau > 1e-4:
        for i in cand:
            if len(picked) >= top_n:
                break
            if any(np.sqrt((((kvec(i) - kvec(j)) / kspan) ** 2).sum()) / np.sqrt(len(kidx)) <= tau
                   for j in picked):
                continue
            picked.append(int(i))
        if len(picked) < top_n:
            tau /= 2                         # 湊不滿放寬門檻重掃
            picked = [int(cand[0])] if len(cand) else []
    note = None if feasible_any else "沒有參數組合能同時滿足所有範圍條件，以下為最接近可行區的建議。"

    def obj_row(i, pt_idx):
        cond = objectives[i].get("condition") or {}
        ct = cond.get("type", "max")
        p = float(preds_by[i][pt_idx])
        row = {"mid": objectives[i]["mid"], "name": objectives[i].get("name") or recs[i]["target"],
               "pred": round(p, 5), "desirability": round(float(d_by[i][pt_idx]), 3),
               "in_range": None, "margin": None}
        if ct == "range":
            rmin, rmax = float(cond["min"]), float(cond["max"])
            row["in_range"] = bool(rmin < p < rmax)
            row["margin"] = round(min(p - rmin, rmax - p), 5)
        return row

    recs_out = []
    for rank, i in enumerate(picked, 1):
        recs_out.append({
            "rank": rank, "score": round(float(score[i]), 3), "feasible": bool(feas[i]),
            "violated_objectives": [objectives[j].get("name") or recs[j]["target"]
                                    for j in range(len(recs))
                                    if (objectives[j].get("condition") or {}).get("type") == "range"
                                    and not obj_row(j, i)["in_range"]],
            "knobs": {nm: round(float(pool[i, ucol[nm]]), 5) for nm in knob_names},
            "objectives": [obj_row(j, i) for j in range(len(recs))],
        })

    # baseline（起始值那組）供對照
    bpool = ref_row.reshape(1, -1)
    bpb, bdb, bsc, bfe, _ = evaluate(bpool)
    baseline = {"knobs": {nm: round(float(ref_row[ucol[nm]]), 5) for nm in knob_names},
                "score": round(float(bsc[0]), 3), "feasible": bool(bfe[0]),
                "objectives": [obj_row(j, 0) if False else {
                    "mid": objectives[j]["mid"], "name": objectives[j].get("name") or recs[j]["target"],
                    "pred": round(float(bpb[j][0]), 5), "desirability": round(float(bdb[j][0]), 3)}
                    for j in range(len(recs))]}

    return {
        "feasible": feasible_any, "feasible_count": int(feas.sum()),
        "precision": prec, "top_n": top_n, "note": note, "warning": warning,
        "knobs": knob_names,
        "bounds": {nm: [round(knob_range[nm][0], 5), round(knob_range[nm][1], 5)] for nm in knob_names},
        "reference": {f: round(float(v), 5) for f, v in reference.items()},
        "objectives": [{
            "mid": objectives[i]["mid"], "name": objectives[i].get("name") or recs[i]["target"],
            "target": recs[i]["target"], "type": (objectives[i].get("condition") or {}).get("type", "max"),
            "min": (objectives[i].get("condition") or {}).get("min"),
            "max": (objectives[i].get("condition") or {}).get("max"),
            "weight": weights[i], "scale": [round(yscale[i][0], 4), round(yscale[i][1], 4)],
            "ignored_knobs": [nm for nm in knob_names if nm not in recs[i]["features"]],
        } for i in range(len(recs))],
        "recommendations": recs_out,
        "baseline": baseline,
    }
