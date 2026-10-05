#!/usr/bin/env python3
"""
refresh_dtm.py — data pipeline for the MENA Displacement Monitor
================================================================
Writes ../data/data.json, which the app (index.html) reads.

Two data shapes, kept separate on purpose:
  • Yemen  = metric_type "flow"  — NEW weekly displacement in HOUSEHOLDS,
             from the RDT Excel, with origin→destination at district level
             (this is what powers the click-to-drill district view).
  • Others = metric_type "stock" — PRESENT IDPs in INDIVIDUALS on monthly
             rounds, from the DTM API. You never SUM stock across rounds;
             you show the latest round and trend it. Origin→destination is
             included where the API provides it (Iraq, Syria do).

USAGE
  pip install dtmapi pandas geopandas shapely openpyxl requests
  # key: put it in ../.env (DTM_API_KEY=...) or scripts/dtm_key.txt, or export it
  python refresh_dtm.py            # build ../data/data.json
  python refresh_dtm.py --discover # print the API schema (countries/columns)

The key is read from the environment / .env / dtm_key.txt only — never hard-code
or commit it. See ../.gitignore.
"""
import os, sys, json, re, glob, unicodedata, warnings, datetime as dt
warnings.filterwarnings("ignore")

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
DATA_DIR = os.path.join(ROOT, "data")
OUT = os.path.join(DATA_DIR, "data.json")
HH_TO_PEOPLE = 6
YEAR = 2026                      # 2026-only scope

def find_yemen_rdt():
    """Newest RDT workbook dropped in scripts/. To refresh Yemen: download the latest
    'Rapid Displacement Tracking (RDT) Dataset ... District Level.xlsx' from
    dtm.iom.int/datasets (Yemen), drop it here, and re-run — newest file wins (by mtime)."""
    cands = set(glob.glob(os.path.join(HERE, "*Rapid Displacement Tracking*.xlsx")))
    cands |= set(glob.glob(os.path.join(HERE, "*RDT*.xlsx")))
    cands = [p for p in cands if not os.path.basename(p).startswith("~$")]  # skip Excel locks
    return max(cands, key=os.path.getmtime) if cands else None

# SCOPE (decided 2026-09-22): Yemen only.
#   Verified against the DTM IDP API (dtmapi.iom.int/v3/displacement/admin{0,1,2}):
#   - The API serves only the IDP *stock* product. Yemen there ends 2025-02-01 (no 2026),
#     and its cadence is monthly/quarterly, NOT weekly.
#   - Yemen's weekly 2026 movement data is the *RDT* product, published as FILES (HDX +
#     dtm.iom.int), not via this API. So Yemen must come from the RDT workbook/HDX.
#   - Iraq (ends 2024-12) & Lebanon (ends 2025-10) have no 2026 IDP data; Syria has some
#     but is choropleth-only (no origin). All dropped for the 2026-only, Yemen-first app.
# To re-enable API stock countries later, list them here (must match DTM names; --discover).
MENA_API_COUNTRIES = []
ISO3 = {"Yemen":"YEM","Iraq":"IRQ","Libya":"LBY","Sudan":"SDN","Syrian Arab Republic":"SYR","Lebanon":"LBN"}

def load_key():
    k = os.environ.get("DTM_API_KEY")
    if not k:
        for fn in (os.path.join(ROOT, ".env"), os.path.join(HERE, "dtm_key.txt")):
            if os.path.exists(fn):
                for line in open(fn):
                    line = line.strip()
                    if not line or line.startswith("#"): continue
                    k = (line.split("=",1)[1] if "=" in line else line).strip().strip('"').strip("'")
                    break
            if k: break
    if not k:
        sys.exit("No DTM_API_KEY found. Put it in ../.env, scripts/dtm_key.txt, or export DTM_API_KEY.")
    return k

def _norm(s):
    return re.sub(r"[^a-z]","",unicodedata.normalize("NFKD",str(s)).encode("ascii","ignore").decode()
                  .lower().replace("governorate","").replace("city",""))

# ---- geoBoundaries (LFS media endpoint returns the real GeoJSON) ----------
_GB_CACHE = {}
def _gb(iso3, lvl):
    if (iso3, lvl) in _GB_CACHE:
        return _GB_CACHE[(iso3, lvl)].copy()
    import requests, geopandas as gpd, io
    url = (f"https://media.githubusercontent.com/media/wmgeolab/geoBoundaries/"
           f"main/releaseData/gbOpen/{iso3}/{lvl}/geoBoundaries-{iso3}-{lvl}.geojson")
    r = requests.get(url, timeout=180); r.raise_for_status()
    g = gpd.read_file(io.BytesIO(r.content))
    gp = g.to_crs(32638)
    g["lon"] = gp.centroid.to_crs(4326).x; g["lat"] = gp.centroid.to_crs(4326).y
    _GB_CACHE[(iso3, lvl)] = g
    return g.copy()

MON = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"]

# ---- Yemen geography: one aligned ADM2/ADM1 coverage -----------------------
# geoBoundaries ADM1 and ADM2 are separate products; simplifying each polygon on its
# own made shared borders drift apart. Instead ADM2 is simplified as a *coverage*
# (shared edges simplified once, so neighbours stay identical) and governorates are
# the union of their districts — every gov border is exactly a district border.
GEO_TOL = 0.002          # degrees (~200 m); coverage-preserving
# _norm() drops "governorate"/"city", so these two geoBoundaries ADM1 names collide;
# pin them by raw name (the small "Sanʿaʾ" polygon is the capital city).
GB_ADM1_PC = {"Sanʿaʾ": "YE13", "Sanʿaʾ Governorate": "YE23"}
def _dkey(s):
    """District key: like _norm but keeps "city" (Ma'rib vs Ma'rib City are different)."""
    return re.sub(r"[^a-z]","",unicodedata.normalize("NFKD",str(s)).encode("ascii","ignore").decode().lower())
def _rnd(geom):
    import shapely
    return shapely.set_precision(geom, 1e-4)   # ~11 m; identical inputs → identical outputs

def build_yemen_geo(gov, dnames, key, drillable):
    """→ gfeats (ADM1), adm2 (all districts, props pc/name/g), dcent, dbbox.
    `gov` maps data gov pcode → {name,…}; `dnames` data district pcode → name;
    `drillable` = gov pcodes that get a zoom box (destinations in the data)."""
    import shapely, geopandas as gpd
    from shapely.geometry import mapping
    g1=_gb("YEM","ADM1"); g2=_gb("YEM","ADM2")
    g1["pc"]=g1["shapeName"].map(lambda n: GB_ADM1_PC.get(n) or next((pc for pc in gov if key(gov[pc]["name"])==key(n)),"x"+key(n)))
    from shapely.geometry import Point
    for r in g1.itertuples():      # gov anchor = its own polygon's centroid (fixes name collisions),
        if r.pc not in gov: continue   # or an interior point when the centroid falls outside (Sana'a)
        lon,lat=r.lon,r.lat
        if not r.geometry.contains(Point(lon,lat)):
            p=r.geometry.representative_point(); lon,lat=p.x,p.y
            print(f"  · {r.shapeName}: centroid outside polygon → interior anchor")
        gov[r.pc]["lat"]=round(lat,4); gov[r.pc]["lon"]=round(lon,4)
    g2r=g2.copy(); g2r["geometry"]=g2r.geometry.representative_point()
    g1j=g1[["pc","shapeName","geometry"]].rename(columns={"shapeName":"govname"})
    sj=gpd.sjoin(g2r,g1j,how="left",predicate="within")
    sj=sj[~sj.index.duplicated()]
    miss=sj["pc"].isna()           # ADM1/ADM2 coastlines differ slightly → nearest gov
    if miss.any():
        nj=gpd.sjoin_nearest(g2r[miss].to_crs(32638),g1j.to_crs(32638),how="left")
        nj=nj[~nj.index.duplicated()]
        sj.loc[miss,"pc"]=nj["pc"]; sj.loc[miss,"govname"]=nj["govname"]
    g2["govpc"]=sj["pc"].values; g2["govname"]=sj["govname"].values
    g2=g2.dropna(subset=["govpc"]).reset_index(drop=True)
    g2["geometry"]=[_rnd(g) for g in shapely.coverage_simplify(g2.geometry.values, GEO_TOL)]
    gfeats=[]
    for gpc,sub in g2.groupby("govpc"):
        u=_rnd(shapely.coverage_union_all(sub.geometry.values))
        nm=gov[gpc]["name"] if gpc in gov else sub["govname"].iloc[0]
        gfeats.append({"type":"Feature","properties":{"pc":gpc,"name":nm},"geometry":mapping(u)})
    dpc2gov={pc:("YE"+str(pc)[2:4]) for pc in dnames}
    pcs=[None]*len(g2); dcent={}
    for gpc in g2["govpc"].unique():
        sub=g2[g2["govpc"]==gpc]
        gk2={_dkey(r.shapeName):r for r in sub.itertuples()}
        gk2b={key(r.shapeName):r for r in sub.itertuples()}   # looser fallback (synonyms)
        for dpc in [p for p in dnames if dpc2gov.get(p)==gpc]:
            row=gk2.get(_dkey(dnames[dpc]))
            if row is None: row=gk2b.get(key(dnames[dpc]))
            if row is not None:
                dcent[dpc]={"name":dnames[dpc],"lat":round(row.lat,4),"lon":round(row.lon,4),"g":gpc}
                if pcs[row.Index] is None: pcs[row.Index]=dpc
            elif gov.get(gpc,{}).get("lat") is not None:
                dcent[dpc]={"name":dnames[dpc],"lat":gov[gpc]["lat"],"lon":gov[gpc]["lon"],"g":gpc}
    adm2=[]
    for r,pc in zip(g2.itertuples(),pcs):
        adm2.append({"type":"Feature","properties":{"pc":pc or "x"+r.shapeID,
                     "name":dnames.get(pc,r.shapeName),"g":r.govpc},"geometry":mapping(r.geometry)})
    dbbox={}
    for gpc in drillable:
        sub=g2[g2["govpc"]==gpc]
        if len(sub):
            b=sub.total_bounds; dbbox[gpc]=[round(float(v),3) for v in b]
    return gfeats,{"type":"FeatureCollection","features":adm2},dcent,dbbox

# ========================= YEMEN (flow, district drill) ====================
def build_yemen():
    import pandas as pd, geopandas as gpd
    from shapely.geometry import mapping, shape
    xlsx = find_yemen_rdt()
    if not xlsx:
        print(f"  ! No Yemen RDT .xlsx in {HERE} — download the latest from dtm.iom.int/datasets"); return None
    print("  · using RDT file:", os.path.basename(xlsx))
    df = pd.read_excel(xlsx, sheet_name="IDPs").rename(columns={"Total Number Of Households":"hh"})
    df["hh"] = pd.to_numeric(df["hh"], errors="coerce").fillna(0)
    df["dt"] = pd.to_datetime(df["Date of Event"], errors="coerce")
    # 2026-only; upper bound follows the data (so a newer workbook just extends the weeks).
    df = df[(df["dt"] >= f"{YEAR}-01-01") & (df["dt"] <= f"{YEAR}-12-31")].dropna(subset=["dt"]).copy()
    df["ogp"],df["dgp"]=df["Gov_Coming_Pcode"],df["Gov_Pcode"]
    df["odp"],df["ddp"]=df["Dis_Coming_Pcode"],df["Dis_Pcode"]
    syn={"aden":"adan","alhodeidah":"alhudaydah","hadramawt":"hadhramaut","taiz":"taizz","lahj":"lahij",
         "almaharah":"almahrah","sanaacity":"sana","sanaa":"sana","adali":"addali"}
    key=lambda s: syn.get(_norm(s),_norm(s))
    gnames={}
    for pc,nm in pd.concat([df[["dgp","Governorate"]].rename(columns={"dgp":"pc","Governorate":"nm"}),
                            df[["ogp","Governorate Coming From"]].rename(columns={"ogp":"pc","Governorate Coming From":"nm"})]
                           ).dropna().drop_duplicates().itertuples(index=False): gnames[pc]=nm
    g1=_gb("YEM","ADM1"); gk={key(r.shapeName):r for r in g1.itertuples()}
    gov={pc:{"name":gnames[pc],"lat":round(gk[key(gnames[pc])].lat,4) if key(gnames[pc]) in gk else None,
             "lon":round(gk[key(gnames[pc])].lon,4) if key(gnames[pc]) in gk else None} for pc in gnames}
    # weeks — RDT weekly grid anchored at YEAR-01-04, generated FORWARD to the newest
    # event date (capped at today), so a fresher workbook automatically adds weeks.
    start0=pd.Timestamp(f"{YEAR}-01-04")
    maxd=min(df["dt"].max(), pd.Timestamp("today").normalize())
    df=df[df["dt"]<=maxd].copy()
    weeks=[]; i=0; cur=start0
    while cur<=maxd:
        e=cur+pd.Timedelta(days=6)
        weeks.append({"start":cur.strftime("%Y-%m-%d"),"end":e.strftime("%Y-%m-%d"),
            "label":f"{cur.day} {MON[cur.month-1]}–{e.day} {MON[e.month-1]}","i":i})
        cur+=pd.Timedelta(days=7); i+=1
    print(f"  · weeks: {len(weeks)} (through {weeks[-1]['end'] if weeks else 'n/a'})")
    def wi(d):
        for w in weeks:
            if pd.Timestamp(w["start"])<=d<=pd.Timestamp(w["end"]): return w["i"]
    df["wi"]=df["dt"].map(wi); df=df.dropna(subset=["wi"]); df["wi"]=df["wi"].astype(int)
    dnames={}
    for pc,nm in pd.concat([df[["ddp","District"]].rename(columns={"ddp":"pc","District":"nm"}),
                            df[["odp","District Coming From"]].rename(columns={"odp":"pc","District Coming From":"nm"})]
                           ).dropna().drop_duplicates().itertuples(index=False): dnames[pc]=nm
    gfeats,adm2,dcent,dbbox=build_yemen_geo(gov,dnames,key,set(df["dgp"].dropna()))
    perweek=[]
    for w in weeks:
        sub=df[df.wi==w["i"]]
        dest=sub.groupby("dgp")["hh"].sum().round().astype(int)
        flows=sub.groupby(["ogp","dgp"])["hh"].sum().round().astype(int).reset_index()
        rea=sub.groupby("Reason for Displacement")["hh"].sum().round().astype(int)
        dfl=sub.groupby(["ogp","odp","dgp","ddp"])["hh"].sum().round().astype(int).reset_index()
        perweek.append({"i":w["i"],"total":int(sub["hh"].sum()),
            "dest":{k:int(v) for k,v in dest.items()},
            "flows":[{"o":r.ogp,"d":r.dgp,"hh":int(r.hh)} for r in flows.itertuples()],
            "reasons":{k:int(v) for k,v in rea.items()},
            "dflows":[{"og":r.ogp,"od":r.odp,"dg":r.dgp,"dd":r.ddp,"hh":int(r.hh)} for r in dfl.itertuples() if r.hh>0]})
    return {"country":"Yemen","label":"Rapid Displacement Tracking",
            "subtitle":"New internal displacement (weekly RDT) — origin → destination",
            "iso":"YEM","metric_type":"flow","unit":"households","hh_to_people":HH_TO_PEOPLE,"people_basis":"estimate",
            "weeks":weeks,"perweek":perweek,"gov":gov,"geo":{"type":"FeatureCollection","features":gfeats},
            "dcent":dcent,"adm2":adm2,"dbbox":dbbox,"total_all":int(df["hh"].sum())}

# ================== YEMEN — West Coast Escalation (flow, daily) =============
def find_escalation():
    """Newest 'Displacement Caused by Escalation in the West Coast' workbook in scripts/.
    Download the latest from dtm.iom.int/datasets (Yemen) and drop it here; newest wins."""
    cands = set(glob.glob(os.path.join(HERE, "*Escalation*.xlsx")))
    cands = [p for p in cands if not os.path.basename(p).startswith("~$")]
    return max(cands, key=os.path.getmtime) if cands else None

def build_escalation():
    """Daily west-coast escalation displacement → same flow payload as the RDT, but valued
    in real INDIVIDUALS (the file provides them) with district→district origin-destination.
    Reuses the RDT geo/week/aggregation logic verbatim, keyed to this file's columns."""
    import pandas as pd, geopandas as gpd
    from shapely.geometry import mapping, shape
    xlsx = find_escalation()
    if not xlsx:
        print("  · no escalation workbook in scripts/ — skipping"); return None
    print("  · escalation file:", os.path.basename(xlsx))
    # IOM varies the layout between issues (sheet "compilation" vs "Dataset"; headers like
    # "Governorate*", "Governorate*2", "District"), so find the sheet by its columns and
    # normalise headers by dropping the "*" / "*2" markers.
    REQ = ["Displacement Date","Governorate_Pcode","Governorate","District_Pcode","District",
           "Origin Governorate_Pcode","Origin Governorate","Origin District_Pcode","Origin District",
           "HH Displaced"]
    norm = lambda c: re.sub(r"\s*\*\d*\s*$", "", str(c)).strip()
    df = None
    for sh, d in pd.read_excel(xlsx, sheet_name=None).items():
        d = d.rename(columns=norm)
        if all(c in d.columns for c in REQ): df = d; print(f"  · sheet: {sh}"); break
    if df is None:
        raise SystemExit(f"  ! {os.path.basename(xlsx)}: no sheet has the columns {REQ}")
    # Households (consistent with the RDT dataset). This file also reports individuals;
    # the app shows people via hh_to_people = IOM's individuals ÷ households, labelled as
    # reported (IOM itself derives individuals from households × an average HH size).
    df["val"] = pd.to_numeric(df["HH Displaced"], errors="coerce").fillna(0)
    df["ind"] = pd.to_numeric(df.get("Individuals Displaced"), errors="coerce")
    df["dt"] = pd.to_datetime(df["Displacement Date"], errors="coerce")
    df = df[(df["dt"] >= f"{YEAR}-01-01") & (df["dt"] <= f"{YEAR}-12-31")].dropna(subset=["dt"]).copy()
    df["dgp"],df["ddp"] = df["Governorate_Pcode"], df["District_Pcode"]
    df["ogp"],df["odp"] = df["Origin Governorate_Pcode"], df["Origin District_Pcode"]
    syn={"aden":"adan","alhodeidah":"alhudaydah","hadramawt":"hadhramaut","taiz":"taizz","lahj":"lahij",
         "almaharah":"almahrah","sanaacity":"sana","sanaa":"sana","adali":"addali","marib":"marib",
         "amanatalaseymah":"sana","amanatalasimah":"sana"}
    key=lambda s: syn.get(_norm(s),_norm(s))
    gnames={}
    for pc,nm in pd.concat([df[["dgp","Governorate"]].rename(columns={"dgp":"pc","Governorate":"nm"}),
                            df[["ogp","Origin Governorate"]].rename(columns={"ogp":"pc","Origin Governorate":"nm"})]
                           ).dropna().drop_duplicates().itertuples(index=False): gnames[pc]=nm
    g1=_gb("YEM","ADM1"); gk={key(r.shapeName):r for r in g1.itertuples()}
    gov={pc:{"name":gnames[pc],"lat":round(gk[key(gnames[pc])].lat,4) if key(gnames[pc]) in gk else None,
             "lon":round(gk[key(gnames[pc])].lon,4) if key(gnames[pc]) in gk else None} for pc in gnames}
    start0=pd.Timestamp(f"{YEAR}-01-04"); maxd=min(df["dt"].max(), pd.Timestamp("today").normalize())
    df=df[df["dt"]<=maxd].copy()
    weeks=[]; i=0; cur=start0
    while cur<=maxd:
        e=cur+pd.Timedelta(days=6)
        weeks.append({"start":cur.strftime("%Y-%m-%d"),"end":e.strftime("%Y-%m-%d"),
            "label":f"{cur.day} {MON[cur.month-1]}–{e.day} {MON[e.month-1]}","i":i})
        cur+=pd.Timedelta(days=7); i+=1
    print(f"  · escalation weeks: {len(weeks)} (through {weeks[-1]['end'] if weeks else 'n/a'})")
    def wi(d):
        for w in weeks:
            if pd.Timestamp(w["start"])<=d<=pd.Timestamp(w["end"]): return w["i"]
    df["wi"]=df["dt"].map(wi); df=df.dropna(subset=["wi"]); df["wi"]=df["wi"].astype(int)
    dnames={}
    for pc,nm in pd.concat([df[["ddp","District"]].rename(columns={"ddp":"pc","District":"nm"}),
                            df[["odp","Origin District"]].rename(columns={"odp":"pc","Origin District":"nm"})]
                           ).dropna().drop_duplicates().itertuples(index=False): dnames[pc]=nm
    gfeats,adm2,dcent,dbbox=build_yemen_geo(gov,dnames,key,set(df["dgp"].dropna()))
    perweek=[]
    for w in weeks:
        sub=df[df.wi==w["i"]]
        dest=sub.groupby("dgp")["val"].sum().round().astype(int)
        flows=sub.groupby(["ogp","dgp"])["val"].sum().round().astype(int).reset_index()
        dfl=sub.groupby(["ogp","odp","dgp","ddp"])["val"].sum().round().astype(int).reset_index()
        perweek.append({"i":w["i"],"total":int(sub["val"].sum()),
            "dest":{k:int(v) for k,v in dest.items()},
            "flows":[{"o":r.ogp,"d":r.dgp,"hh":int(r.val)} for r in flows.itertuples()],
            "reasons":{"Conflict (west-coast escalation)":int(sub["val"].sum())},
            "dflows":[{"og":r.ogp,"od":r.odp,"dg":r.dgp,"dd":r.ddp,"hh":int(r.val)} for r in dfl.itertuples() if r.val>0]})
    ratio=HH_TO_PEOPLE; basis="estimate"
    if df["ind"].notna().any() and df["val"].sum()>0:
        ratio=round(float(df["ind"].sum()/df["val"].sum()),2); basis="reported"
        r=(df["ind"]/df["val"].where(df["val"]>0)).dropna()
        if len(r) and (r.max()-r.min())>0.01:
            print(f"  ! individuals/household varies by row ({r.min():.2f}–{r.max():.2f}); sub-totals use the overall {ratio}")
    print(f"  ✓ Escalation: {len(gov)} govs, {len(dbbox)} govs w/ districts, total {int(df['val'].sum()):,} households")
    return {"country":"Yemen","label":"West Coast Escalation",
            "subtitle":"Displacement from the west-coast escalation (daily) — origin → destination",
            "iso":"YEM","metric_type":"flow","unit":"households","hh_to_people":ratio,"people_basis":basis,
            "weeks":weeks,"perweek":perweek,"gov":gov,"geo":{"type":"FeatureCollection","features":gfeats},
            "dcent":dcent,"adm2":adm2,"dbbox":dbbox,"total_all":int(df["val"].sum())}

# ========================= API countries (stock) ===========================
def build_api_country(api, name):
    import pandas as pd
    from shapely.geometry import mapping
    try:
        d = api.get_idp_admin1_data(CountryName=name)
    except Exception as e:
        print(f"  ! {name}: API error {repr(e)[:120]}"); return None
    if d is None or len(d)==0: print(f"  ! {name}: no data"); return None
    d["numPresentIdpInd"]=pd.to_numeric(d["numPresentIdpInd"],errors="coerce").fillna(0)
    d["rd"]=pd.to_datetime(d["reportingDate"],errors="coerce"); d=d.dropna(subset=["rd"])
    if len(d)==0: return None
    op=d.loc[d["rd"].idxmax(),"operation"]; d=d[d["operation"]==op]          # one coherent operation
    dates=sorted(d["rd"].unique())
    weeks=[{"i":i,"start":pd.Timestamp(x).strftime("%Y-%m-%d"),"end":pd.Timestamp(x).strftime("%Y-%m-%d"),
            "label":pd.Timestamp(x).strftime("%b %Y")} for i,x in enumerate(dates)]
    g=_gb(ISO3[name],"ADM1"); gk={_norm(r.shapeName):r for r in g.itertuples()}
    gov={}
    def add(pc,nm):
        if pc in gov or pc is None: return
        row=gk.get(_norm(nm)); gov[pc]={"name":str(nm),"lat":round(row.lat,4) if row is not None else None,
                                        "lon":round(row.lon,4) if row is not None else None}
    perweek=[]
    NA={"not available","none","",None}
    for i,x in enumerate(dates):
        sub=d[d["rd"]==x]
        dest=sub.groupby("admin1Pcode")["numPresentIdpInd"].sum().round().astype(int)
        for pc,gg in sub.groupby("admin1Pcode"): add(pc, gg["admin1Name"].iloc[0])
        fl=sub[~sub["idpOriginAdmin1Pcode"].astype(str).str.lower().isin(NA)]
        flows=[]
        if len(fl):
            for (o,dd),v in fl.groupby(["idpOriginAdmin1Pcode","admin1Pcode"])["numPresentIdpInd"].sum().items():
                add(o, fl[fl["idpOriginAdmin1Pcode"]==o]["idpOriginAdmin1Name"].iloc[0])
                flows.append({"o":o,"d":dd,"hh":int(round(v))})
        rea=sub.groupby("displacementReason")["numPresentIdpInd"].sum().round().astype(int)
        perweek.append({"i":i,"total":int(sub["numPresentIdpInd"].sum()),"dest":{k:int(v) for k,v in dest.items()},
                        "flows":flows,"reasons":{k:int(v) for k,v in rea.items()}})
    g["pc"]=g["shapeName"].map(lambda n: next((pc for pc in gov if _norm(gov[pc]["name"])==_norm(n)),None))
    gs=g.dropna(subset=["pc"]).copy(); gs["geometry"]=gs.geometry.simplify(0.02,preserve_topology=True)
    feats=[{"type":"Feature","properties":{"pc":r.pc,"name":gov[r.pc]["name"]},"geometry":mapping(r.geometry)} for r in gs.itertuples()]
    print(f"  ✓ {name}: op='{op}'  rounds={len(dates)}  admin1={len(gov)}  flows/round≈{len(perweek[-1]['flows']) if perweek else 0}")
    return {"country":name,"iso":ISO3[name],"metric_type":"stock","unit":"individuals","hh_to_people":1,
            "operation":op,"weeks":weeks,"perweek":perweek,"gov":gov,
            "geo":{"type":"FeatureCollection","features":feats},"total_latest":perweek[-1]["total"] if perweek else 0}

# ---- discovery ----
def discover(api):
    out=[]; w=lambda *a:(print(" ".join(map(str,a))),out.append(" ".join(map(str,a))))
    for title,fn in [("COUNTRIES",api.get_all_countries),("OPERATIONS",api.get_all_operations)]:
        w(f"=== {title} ===")
        try:
            r=fn(); w(r.to_string() if hasattr(r,"to_string") else str(r))
        except Exception as e: w("  ERROR:",repr(e)[:300])
    for name in MENA_API_COUNTRIES:
        w(f"\n=== ADMIN1 sample: {name} ===")
        try:
            d=api.get_idp_admin1_data(CountryName=name); w("columns:",list(d.columns)); w("rows:",len(d)); w(d.head(4).to_string())
        except Exception as e: w("  ERROR:",repr(e)[:300])
    p=os.path.join(HERE,"discover_output.txt"); open(p,"w",encoding="utf-8").write("\n".join(out)); print("\n--- saved",p,"---")

def main():
    if "--discover" in sys.argv:
        from dtmapi import DTMApi; discover(DTMApi(subscription_key=load_key())); return
    os.makedirs(DATA_DIR, exist_ok=True)
    datasets={}   # keyed by label (the app's selector); both Yemen datasets share the map engine
    print("Yemen — Rapid Displacement Tracking (weekly) ..."); y=build_yemen()
    print("Yemen — West Coast Escalation (daily) ..."); e=build_escalation()
    # Give the escalation the FULL Yemen governorate geography (all 21 ADM1 boundaries +
    # names + district geo) that the RDT resolved, so no governorate disappears and the
    # neighbour-context / district drill behave exactly like the RDT map.
    if e and y:
        e["geo"]=y["geo"]
        e["gov"]={**y["gov"], **e["gov"]}
        for k in ("dcent","dbbox"):   # prefer the RDT's fuller district matches
            merged=dict(e.get(k,{})); merged.update(y.get(k,{})); e[k]=merged
        # Same ADM2 coverage in both (same order); keep whichever dataset matched a pcode.
        e["adm2"]={"type":"FeatureCollection","features":[
            fe if fy["properties"]["pc"].startswith("x") and not fe["properties"]["pc"].startswith("x") else fy
            for fy,fe in zip(y["adm2"]["features"],e["adm2"]["features"])]}
        y["adm2"]=e["adm2"]
    # selector order: escalation first (it is the default), then RDT
    if e: datasets[e["label"]]=e
    if y: datasets[y["label"]]=y
    # Optional API stock countries (empty by default; see MENA_API_COUNTRIES note above).
    if MENA_API_COUNTRIES:
        from dtmapi import DTMApi
        api=DTMApi(subscription_key=load_key())
        for name in MENA_API_COUNTRIES:
            print(f"{name} (API) ..."); c=build_api_country(api,name)
            if c: datasets[c.get("label",c["country"])]=c
    default = "West Coast Escalation" if "West Coast Escalation" in datasets else (next(iter(datasets), None))
    data={"generated":dt.date.today().isoformat(),"countries":datasets,"pending":[],"default":default}
    # Datasets with identical geography share one copy (the app fills it back in on load).
    if e and y and e["geo"]==y["geo"] and e["adm2"]==y["adm2"]:
        data["shared"]={"geo":e["geo"],"adm2":e["adm2"]}
        for c in (e,y): del c["geo"], c["adm2"]
    json.dump(data,open(OUT,"w",encoding="utf-8"),ensure_ascii=False,separators=(",",":"))
    print(f"\nWrote {OUT} ({round(os.path.getsize(OUT)/1024,1)} KB) — datasets: {list(datasets)} · default: {default}")

if __name__ == "__main__":
    main()
