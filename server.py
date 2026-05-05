"""
FinancialViz server.py  —  Flask REST API + ETL pipeline + ML model layer
Single-screen no-scroll dashboard backend.

Endpoints
---------
GET  /                      index.html
GET  /api/status            pipeline + model health
GET  /api/dashboard         all data needed for the full dashboard in one call
GET  /api/candlestick       OHLCV for one ticker
GET  /api/elbow             inertia curve data
GET  /api/correlation       return correlation matrix
POST /api/refresh           re-run ETL + retrain
"""

import logging, warnings
from datetime import datetime
from pathlib import Path

import numpy as np
import pandas as pd
from flask import Flask, jsonify, request
from flask_cors import CORS
from sklearn.cluster import KMeans
from sklearn.decomposition import PCA
from sklearn.ensemble import GradientBoostingClassifier
from sklearn.manifold import MDS
from sklearn.preprocessing import StandardScaler
import joblib

warnings.filterwarnings("ignore")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("finsight")

BASE_DIR  = Path(__file__).parent
DATA_DIR  = BASE_DIR / "data"
MODEL_DIR = BASE_DIR / "models"
DATA_DIR.mkdir(exist_ok=True)
MODEL_DIR.mkdir(exist_ok=True)

# ── Ticker universe ────────────────────────────────────────────────────────────
DEFAULT_TICKERS = [
    "AAPL","MSFT","GOOGL","META","NVDA","AMD","CRM","ADBE",       # Tech
    "JPM","BAC","GS","MS","BRK-B","AXP","BLK","C",               # Finance
    "JNJ","UNH","PFE","ABBV","MRK","TMO","ABT","DHR",             # Healthcare
    "AMZN","TSLA","HD","MCD","NKE","SBUX","COST","WMT",           # Consumer
    "XOM","CVX","COP","EOG","SLB","PSX",                          # Energy
    "BA","CAT","HON","GE","UPS","FDX",                            # Industrials
]

SECTORS = {
    "AAPL":"Tech","MSFT":"Tech","GOOGL":"Tech","META":"Tech","NVDA":"Tech",
    "AMD":"Tech","CRM":"Tech","ADBE":"Tech",
    "JPM":"Finance","BAC":"Finance","GS":"Finance","MS":"Finance","BRK-B":"Finance",
    "AXP":"Finance","BLK":"Finance","C":"Finance",
    "JNJ":"Healthcare","UNH":"Healthcare","PFE":"Healthcare","ABBV":"Healthcare",
    "MRK":"Healthcare","TMO":"Healthcare","ABT":"Healthcare","DHR":"Healthcare",
    "AMZN":"Consumer","TSLA":"Consumer","HD":"Consumer","MCD":"Consumer",
    "NKE":"Consumer","SBUX":"Consumer","COST":"Consumer","WMT":"Consumer",
    "XOM":"Energy","CVX":"Energy","COP":"Energy","EOG":"Energy","SLB":"Energy","PSX":"Energy",
    "BA":"Industrials","CAT":"Industrials","HON":"Industrials","GE":"Industrials",
    "UPS":"Industrials","FDX":"Industrials",
}

FEATURE_COLS = [
    "ret_5d","ret_21d","ret_63d","ret_252d",
    "vol_21","vol_63","vol_252",
    "sharpe_21","sharpe_63","sharpe_252",
    "price_to_sma20","price_to_sma200","trend_slope",
    "rsi","vol_ratio","drawdown_63d",
]

# ── ETL Pipeline ───────────────────────────────────────────────────────────────

class ETLPipeline:
    def __init__(self):
        self.raw_path     = DATA_DIR / "raw_prices.parquet"
        self.feature_path = DATA_DIR / "features.parquet"
        self.last_run     = None
        self.status       = "idle"

    def ingest(self, tickers=None, period="2y"):
        tickers = tickers or DEFAULT_TICKERS
        try:
            import yfinance as yf
            raw = yf.download(tickers, period=period, auto_adjust=True, progress=False)
            if raw.empty:
                raise ValueError("empty")
            close  = raw["Close"]  if "Close"  in raw.columns else raw.xs("Close",  axis=1, level=0)
            volume = raw["Volume"] if "Volume" in raw.columns else raw.xs("Volume", axis=1, level=0)
            high   = raw["High"]   if "High"   in raw.columns else raw.xs("High",   axis=1, level=0)
            low    = raw["Low"]    if "Low"    in raw.columns else raw.xs("Low",    axis=1, level=0)
            open_  = raw["Open"]   if "Open"   in raw.columns else raw.xs("Open",   axis=1, level=0)
            df = pd.concat([close.stack().rename("Close"), volume.stack().rename("Volume"),
                            high.stack().rename("High"),   low.stack().rename("Low"),
                            open_.stack().rename("Open")], axis=1)
            df.index.names = ["Date","Ticker"]
            return df.reset_index()
        except Exception as e:
            log.warning(f"yfinance failed ({e}), using synthetic data")
            return self._synthetic(tickers)

    def _synthetic(self, tickers, n_days=504):
        np.random.seed(42)
        dates = pd.bdate_range(end=datetime.today(), periods=n_days)
        sector_drift = {"Tech":0.0007,"Finance":0.0003,"Healthcare":0.0005,
                        "Consumer":0.0004,"Energy":0.0002,"Industrials":0.0003}
        records = []
        for t in tickers:
            drift = sector_drift.get(SECTORS.get(t,"Tech"), 0.0004)
            vol   = np.random.uniform(0.016, 0.028)
            price = np.random.uniform(60, 500)
            prices = [price]
            for _ in range(n_days - 1):
                prices.append(prices[-1] * (1 + np.random.normal(drift, vol)))
            prices = np.array(prices)
            noise  = np.random.uniform(0.003, 0.010, n_days)
            for i, d in enumerate(dates):
                records.append(dict(Date=d, Ticker=t,
                    Open=round(prices[i]*(1+np.random.uniform(-0.004,0.004)),2),
                    High=round(prices[i]*(1+noise[i]),2),
                    Low=round(prices[i]*(1-noise[i]),2),
                    Close=round(prices[i],2),
                    Volume=int(np.random.lognormal(15,0.5))))
        return pd.DataFrame(records)

    def clean(self, df):
        df = df.copy()
        df["Date"] = pd.to_datetime(df["Date"])
        df = df.dropna(subset=["Close"])
        df = df[df["Close"] > 0].sort_values(["Ticker","Date"])
        filled = []
        for ticker, g in df.groupby("Ticker"):
            g2 = g.set_index("Date").drop(columns=["Ticker"], errors="ignore")
            g2 = g2.asfreq("B").ffill().reset_index()
            g2["Ticker"] = ticker
            filled.append(g2)
        return pd.concat(filled, ignore_index=True)

    def engineer(self, df):
        records = []
        for ticker, g in df.groupby("Ticker"):
            g = g.sort_values("Date").copy()
            c = g["Close"].values
            if len(c) < 63: continue
            r1 = pd.Series(c).pct_change(1)
            r5 = pd.Series(c).pct_change(5)
            r21 = pd.Series(c).pct_change(21)
            r63 = pd.Series(c).pct_change(63)
            r252 = pd.Series(c).pct_change(252)
            v21  = r1.rolling(21).std()  * np.sqrt(252)
            v63  = r1.rolling(63).std()  * np.sqrt(252)
            v252 = r1.rolling(252).std() * np.sqrt(252)
            s21  = (r1.rolling(21).mean()  * 252) / (v21  + 1e-9)
            s63  = (r1.rolling(63).mean()  * 252) / (v63  + 1e-9)
            s252 = (r1.rolling(252).mean() * 252) / (v252 + 1e-9)
            sma20  = pd.Series(c).rolling(20).mean()
            sma50  = pd.Series(c).rolling(50).mean()
            sma200 = pd.Series(c).rolling(200).mean()
            delta = r1.copy()
            gain  = delta.clip(lower=0).rolling(14).mean()
            loss  = (-delta.clip(upper=0)).rolling(14).mean()
            rsi   = 100 - 100 / (1 + gain / (loss + 1e-9))
            vol_ratio = pd.Series(g["Volume"].values) / (pd.Series(g["Volume"].values).rolling(20).mean() + 1e-9)
            roll_max  = pd.Series(c).rolling(63).max()
            drawdown  = (pd.Series(c) - roll_max) / (roll_max + 1e-9)
            feat = pd.DataFrame({
                "Date": g["Date"].values, "Ticker": ticker, "Sector": SECTORS.get(ticker,"Unknown"),
                "Close": c, "Volume": g["Volume"].values,
                "Open": g["Open"].values, "High": g["High"].values, "Low": g["Low"].values,
                "ret_1d": r1.values, "ret_5d": r5.values, "ret_21d": r21.values,
                "ret_63d": r63.values, "ret_252d": r252.values,
                "vol_21": v21.values, "vol_63": v63.values, "vol_252": v252.values,
                "sharpe_21": s21.values, "sharpe_63": s63.values, "sharpe_252": s252.values,
                "price_to_sma20": pd.Series(c)/(sma20+1e-9),
                "price_to_sma200": pd.Series(c)/(sma200+1e-9),
                "trend_slope": (sma20-sma50)/(sma50+1e-9),
                "rsi": rsi.values, "vol_ratio": vol_ratio.values, "drawdown_63d": drawdown.values,
            })
            feat["forward_ret_21d"] = feat["ret_21d"].shift(-21)
            feat["label"] = pd.cut(feat["forward_ret_21d"],
                bins=[-np.inf,-0.03,0.03,np.inf], labels=["underperform","neutral","outperform"])
            records.append(feat)
        return pd.concat(records, ignore_index=True)

    def run(self, tickers=None):
        self.status = "running"
        try:
            raw  = self.ingest(tickers)
            raw  = self.clean(raw)
            feat = self.engineer(raw)
            feat.to_parquet(self.feature_path, index=False)
            raw.to_parquet(self.raw_path, index=False)
            self.last_run = datetime.utcnow().isoformat()
            self.status   = "ok"
            log.info(f"Pipeline done: {len(feat)} rows, {feat['Ticker'].nunique()} tickers")
            return feat
        except Exception as e:
            self.status = f"error: {e}"
            log.error(f"Pipeline failed: {e}")
            raise

    def load(self):
        if self.feature_path.exists():
            return pd.read_parquet(self.feature_path)
        return self.run()


# ── ML Model Layer ─────────────────────────────────────────────────────────────

class ModelLayer:
    def __init__(self):
        self.clf     = None
        self.scaler  = None
        self.kmeans  = None
        self.feature_importance = None
        self.k       = 6

    def _prep(self, df):
        latest = df.sort_values("Date").groupby("Ticker").last().reset_index()
        latest[FEATURE_COLS] = latest[FEATURE_COLS].fillna(latest[FEATURE_COLS].median())
        return latest.dropna(subset=FEATURE_COLS)

    def train_classifier(self, df):
        log.info("Training classifier …")
        sub = df.dropna(subset=["label"]).copy()
        sub = sub[sub["label"] != "neutral"]
        sub[FEATURE_COLS] = sub[FEATURE_COLS].fillna(sub[FEATURE_COLS].median())
        sub = sub.dropna(subset=FEATURE_COLS)
        if len(sub) < 20:
            log.warning("Not enough data to train"); return
        X = sub[FEATURE_COLS].values
        y = (sub["label"] == "outperform").astype(int).values
        self.scaler = StandardScaler()
        Xs = self.scaler.fit_transform(X)
        self.clf = GradientBoostingClassifier(n_estimators=200, max_depth=4,
            learning_rate=0.05, subsample=0.8, random_state=42)
        self.clf.fit(Xs, y)
        self.feature_importance = dict(zip(FEATURE_COLS, self.clf.feature_importances_))
        joblib.dump(self.clf,    MODEL_DIR / "clf.joblib")
        joblib.dump(self.scaler, MODEL_DIR / "scaler.joblib")
        log.info("Classifier trained")

    def train_clustering(self, df, k=None):
        self.k = k or self.k
        log.info(f"Training KMeans k={self.k} …")
        valid = self._prep(df)
        if valid.empty or self.scaler is None: return
        X = self.scaler.transform(valid[FEATURE_COLS].values)
        self.kmeans = KMeans(n_clusters=self.k, random_state=42, n_init=10)
        self.kmeans.fit(X)
        joblib.dump(self.kmeans, MODEL_DIR / "kmeans.joblib")
        log.info("Clustering done")

    def load(self):
        p = MODEL_DIR / "clf.joblib"
        s = MODEL_DIR / "scaler.joblib"
        c = MODEL_DIR / "kmeans.joblib"
        if p.exists(): self.clf    = joblib.load(p)
        if s.exists(): self.scaler = joblib.load(s)
        if c.exists(): self.kmeans = joblib.load(c)
        if self.clf and self.feature_importance is None:
            self.feature_importance = dict(zip(FEATURE_COLS, self.clf.feature_importances_))

    def predict_all(self, df):
        if not self.clf or not self.scaler: return {}
        valid = self._prep(df)
        if valid.empty: return {}
        X     = self.scaler.transform(valid[FEATURE_COLS].values)
        probs = self.clf.predict_proba(X)[:,1]
        out   = {}
        for i, (_, row) in enumerate(valid.iterrows()):
            p = float(probs[i])
            out[row["Ticker"]] = {
                "prob": round(p,4),
                "label": "outperform" if p>=0.55 else "underperform" if p<=0.45 else "neutral"
            }
        return out

    def cluster_all(self, df, k=None):
        if k and k != self.k: self.train_clustering(df, k)
        if not self.kmeans or not self.scaler: return {}
        valid = self._prep(df)
        if valid.empty: return {}
        X      = self.scaler.transform(valid[FEATURE_COLS].values)
        labels = self.kmeans.predict(X)
        return {row["Ticker"]: int(labels[i]) for i, (_,row) in enumerate(valid.iterrows())}

    def mds_all(self, df):
        valid = self._prep(df)
        if valid.empty or not self.scaler: return []
        X     = self.scaler.transform(valid[FEATURE_COLS].values)
        X_pca = PCA(n_components=min(10,X.shape[1])).fit_transform(X)
        coords = MDS(n_components=2, random_state=42, max_iter=300, n_init=4).fit_transform(X_pca)
        clusters = self.cluster_all(df)
        preds    = self.predict_all(df)
        out = []
        for i, (_, row) in enumerate(valid.iterrows()):
            t = row["Ticker"]
            out.append({
                "ticker": t, "sector": row.get("Sector","?"),
                "cluster": clusters.get(t,0), "label": preds.get(t,{}).get("label","neutral"),
                "x": round(float(coords[i,0]),4), "y": round(float(coords[i,1]),4),
                "ret_252d": round(float(row.get("ret_252d",0)),4),
                "vol_252":  round(float(row.get("vol_252",0.2)),4),
                "sharpe_252": round(float(row.get("sharpe_252",0)),4),
                "rsi": round(float(row.get("rsi",50)),1),
            })
        return out

    def elbow_data(self, df, max_k=12):
        valid = self._prep(df)
        if valid.empty or not self.scaler: return []
        X = self.scaler.transform(valid[FEATURE_COLS].values)
        return [{"k":k,"inertia":round(float(
            KMeans(n_clusters=k,random_state=42,n_init=5).fit(X).inertia_),2)}
            for k in range(1, max_k+1)]

    def corr_matrix(self, df):
        pivot = df.pivot_table(index="Date", columns="Ticker", values="ret_1d")
        pivot = pivot.dropna(axis=1, thresh=int(len(pivot)*0.6))
        tickers = pivot.columns.tolist()[:28]  # cap for readability
        corr = pivot[tickers].corr().round(3)
        return {"tickers": tickers, "matrix": corr.values.tolist()}


# ── Flask App ──────────────────────────────────────────────────────────────────

app      = Flask(__name__, static_folder="static", template_folder="templates")
CORS(app)

pipeline = ETLPipeline()
model    = ModelLayer()
_df: pd.DataFrame = None

def get_df():
    global _df
    if _df is None:
        _df = pipeline.load()
        model.load()
        if model.clf    is None: model.train_classifier(_df)
        if model.kmeans is None: model.train_clustering(_df)
    return _df

def safe(v):
    if isinstance(v, float) and (np.isnan(v) or np.isinf(v)): return 0.0
    return v

@app.route("/")
def index():
    from flask import send_from_directory
    return send_from_directory("templates","index.html")

@app.route("/api/status")
def status():
    return jsonify({"status": pipeline.status, "last_run": pipeline.last_run,
                    "model": model.clf is not None})

@app.route("/api/dashboard")
def dashboard():
    """Return everything needed to render the full dashboard in one request."""
    df = get_df()
    k  = request.args.get("k", 6, type=int)

    # Latest snapshot per ticker
    latest = df.sort_values("Date").groupby("Ticker").last().reset_index()
    preds    = model.predict_all(df)
    clusters = model.cluster_all(df, k=k)
    mds      = model.mds_all(df)
    fi       = model.feature_importance or {}

    snap = []
    for _, row in latest.iterrows():
        t = row["Ticker"]
        p = preds.get(t,{})
        snap.append({
            "ticker":   t,
            "sector":   row.get("Sector","?"),
            "cluster":  clusters.get(t,0),
            "label":    p.get("label","neutral"),
            "prob":     p.get("prob",0.5),
            "ret_252d": safe(round(float(row.get("ret_252d",0)),4)),
            "ret_63d":  safe(round(float(row.get("ret_63d",0)),4)),
            "ret_21d":  safe(round(float(row.get("ret_21d",0)),4)),
            "vol_252":  safe(round(float(row.get("vol_252",0.2)),4)),
            "sharpe_252": safe(round(float(row.get("sharpe_252",0)),3)),
            "rsi":        safe(round(float(row.get("rsi",50)),1)),
            "drawdown_63d": safe(round(float(row.get("drawdown_63d",0)),4)),
            "trend_slope":  safe(round(float(row.get("trend_slope",0)),4)),
            "price_to_sma200": safe(round(float(row.get("price_to_sma200",1)),4)),
            "close":    safe(round(float(row.get("Close",0)),2)),
        })

    # Feature importances sorted
    fi_sorted = sorted([{"feature":k,"importance":round(float(v),5)}
                         for k,v in fi.items()], key=lambda x:x["importance"], reverse=True)

    return jsonify({"snapshot": snap, "mds": mds, "features": fi_sorted})

@app.route("/api/candlestick")
def candlestick():
    ticker = request.args.get("ticker","AAPL")
    limit  = request.args.get("limit", 120, type=int)
    df = get_df()
    g  = df[df["Ticker"]==ticker].sort_values("Date").tail(limit)
    cols = ["Date","Open","High","Low","Close","Volume","rsi","ret_1d"]
    cols = [c for c in cols if c in g.columns]
    out = g[cols].copy()
    out["Date"] = out["Date"].astype(str)
    return jsonify(out.fillna(0).to_dict(orient="records"))

@app.route("/api/elbow")
def elbow():
    return jsonify(model.elbow_data(get_df()))

@app.route("/api/correlation")
def correlation():
    return jsonify(model.corr_matrix(get_df()))

@app.route("/api/refresh", methods=["POST"])
def refresh():
    global _df
    _df = None
    _df = pipeline.run()
    model.train_classifier(_df)
    model.train_clustering(_df)
    return jsonify({"status":"ok","rows":len(_df)})

if __name__ == "__main__":
    log.info("Warming up …")
    get_df()
    app.run(debug=True, port=5000)
