"""A test library of freely licensed photos and videos, for trying Lumina (app, server, clients) without
anyone's own pictures.

  python scripts/test-library/build_test_library.py select     -> picks files, writes manifest.json (once)
  python scripts/test-library/build_test_library.py build [dir] -> downloads them into dir (default
                                                                  C:\\LuminaTest\\Library) and adds test cases

Sources (see manifest.json for every file and LICENSES.md in the built library):
- NASA image and video library: NASA-made media is not copyrighted (NASA media usage guidelines). Only items
  from NASA centres are taken, never ones credited to other organisations.
- raw.pixls.us: camera RAW samples released under CC0 1.0.

Photos are scaled to 2560 px with their EXIF kept (by resize-keep-exif.ps1), so dates, cameras and lenses are
real. The build also adds test cases: an exact copy, a resized copy and a renamed copy (Find duplicates), a
photo without EXIF, and a WhatsApp-style name.
"""
import hashlib, json, os, re, shutil, subprocess, sys, urllib.parse, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
MANIFEST = os.path.join(HERE, "manifest.json")
API = "https://images-api.nasa.gov"
# NASA centres and crews whose photos are NASA works (Johnson, Kennedy, Headquarters, ISS and Artemis crews)
NASA_ID = re.compile(r"^(jsc|KSC-|NHQ|iss0|art00|GRC-|AFRC|LRC-)", re.I)
OTHER_CREDIT = re.compile(r"ESA|CSA|JAXA|Roscosmos|SpaceX|Boeing|Getty|Associated Press|AP Photo|Reuters|Lockheed|Northrop", re.I)
MAX_ORIG_BYTES = 40_000_000
MAX_VIDEO_BYTES = 60_000_000

PEOPLE = ["Reid Wiseman", "Victor Glover", "Christina Koch", "Jeremy Hansen"]
PHOTO_GROUPS = [
    # (folder, query, how many, title must contain)
    ("Artemis II/Crew", "Artemis II crew", 10, "crew"),
    ("Artemis II/Launch", "Artemis II launch", 12, "launch"),
    ("Artemis II/Earth from Orion", "Artemis II Earth", 8, "earth"),
    ("Space Station/Aurora", "aurora International Space Station", 6, "aurora"),
    ("Kennedy Space Center", "Kennedy Space Center sunrise", 6, ""),
]
VIDEO_GROUPS = [("Videos", "Artemis II", 6), ("Videos", "International Space Station timelapse", 3)]
RAW_SAMPLES = [
    # (file id on raw.pixls.us, name to store it under)
    (4660, "Canon EOS R6.CR3"),
    (2414, "Sony ILCE-7M3.ARW"),
    (3587, "Nikon Z 6.NEF"),
    (4264, "Apple iPhone 12 Pro.DNG"),
]


def get_json(url):
    with urllib.request.urlopen(url, timeout=60) as r:
        return json.load(r)


def head_size(url):
    req = urllib.request.Request(url, method="HEAD")
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return int(r.headers.get("Content-Length", 0))
    except Exception:
        return 0


def search(query, media_type):
    q = urllib.parse.urlencode({"q": query, "media_type": media_type, "page_size": 100})
    return get_json(f"{API}/search?{q}")["collection"]["items"]


def is_nasa_work(meta):
    credit = " ".join(str(meta.get(k, "")) for k in ("secondary_creator", "photographer", "center", "description"))
    return bool(NASA_ID.match(meta["nasa_id"])) and not OTHER_CREDIT.search(meta.get("secondary_creator", "") + meta.get("photographer", ""))


def asset_urls(nasa_id):
    return [i["href"].replace("http://", "https://") for i in get_json(f"{API}/asset/{urllib.parse.quote(nasa_id)}")["collection"]["items"]]


def pick_photos(folder, query, count, must, taken):
    out = []
    for item in search(query, "image"):
        meta = item["data"][0]
        nid = meta["nasa_id"]
        if nid in taken or not is_nasa_work(meta) or (must and must.lower() not in meta.get("title", "").lower()):
            continue
        orig = next((u for u in asset_urls(nid) if u.endswith("~orig.jpg")), None)
        size = head_size(orig) if orig else 0
        if not orig or not 0 < size <= MAX_ORIG_BYTES:
            continue
        taken.add(nid)
        out.append({"kind": "photo", "folder": folder, "nasa_id": nid, "title": meta.get("title", ""),
                    "date": meta.get("date_created", "")[:10], "credit": meta.get("photographer") or meta.get("center") or "NASA",
                    "url": orig, "license": "NASA media (not copyrighted)", "file": f"{nid}.jpg"})
        print(f"  {folder}: {nid} ({size // 1_000_000} MB) {meta.get('title', '')[:60]}")
        if len(out) >= count:
            break
    return out


def pick_videos(folder, query, count, taken):
    out = []
    for item in search(query, "video"):
        meta = item["data"][0]
        nid = meta["nasa_id"]
        if nid in taken or not is_nasa_work(meta):
            continue
        urls = asset_urls(nid)
        mp4 = next((u for u in urls if u.endswith("~mobile.mp4")), None) or next((u for u in urls if u.endswith("~small.mp4")), None)
        size = head_size(mp4) if mp4 else 0
        if not mp4 or not 0 < size <= MAX_VIDEO_BYTES:
            continue
        taken.add(nid)
        out.append({"kind": "video", "folder": folder, "nasa_id": nid, "title": meta.get("title", ""),
                    "date": meta.get("date_created", "")[:10], "credit": meta.get("center") or "NASA",
                    "url": mp4, "license": "NASA media (not copyrighted)", "file": f"{nid}.mp4"})
        print(f"  {folder}: {nid} ({size // 1_000_000} MB) {meta.get('title', '')[:60]}")
        if len(out) >= count:
            break
    return out


def select():
    taken, items = set(), []
    for person in PEOPLE:
        items += pick_photos(f"People/{person}", person, 10, person.split()[-1], taken)
    for folder, query, count, must in PHOTO_GROUPS:
        items += pick_photos(folder, query, count, must, taken)
    for folder, query, count in VIDEO_GROUPS:
        items += pick_videos(folder, query, count, taken)
    repo = get_json("https://raw.pixls.us/json/getrepository.php")["data"]
    for file_id, name in RAW_SAMPLES:
        row = next(r for r in repo if f"getfile.php/{file_id}/" in r[7])
        url = re.search(r"href='([^']+)'", row[7]).group(1).replace(" ", "%20")
        sha = re.search(r"sha256 Checksum'>([0-9a-f]+)<", row[7]).group(1)
        items.append({"kind": "raw", "folder": "RAW", "title": f"{row[0]} {row[1]} sample", "credit": "raw.pixls.us",
                      "url": url, "license": "CC0 1.0", "file": name, "sha256": sha})
    with open(MANIFEST, "w", encoding="utf-8") as f:
        json.dump({"items": items}, f, indent=1, ensure_ascii=False)
    print(f"{len(items)} items -> {MANIFEST}")


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while chunk := f.read(1 << 20):
            h.update(chunk)
    return h.hexdigest()


def download(url, dest):
    if os.path.exists(dest):
        return
    tmp = dest + ".part"
    with urllib.request.urlopen(url, timeout=120) as r, open(tmp, "wb") as f:
        shutil.copyfileobj(r, f, 1 << 20)
    os.replace(tmp, dest)


def build(library):
    with open(MANIFEST, encoding="utf-8") as f:
        items = json.load(f)["items"]
    cache = os.path.join(os.path.dirname(library), "Downloads")
    os.makedirs(cache, exist_ok=True)
    os.makedirs(library, exist_ok=True)
    resize = os.path.join(HERE, "resize-keep-exif.ps1")
    for n, it in enumerate(items, 1):
        src = os.path.join(cache, it["file"])
        download(it["url"], src)
        if it.get("sha256") and sha256(src) != it["sha256"]:
            raise SystemExit(f"checksum mismatch: {it['file']}")
        dest_dir = os.path.join(library, *it["folder"].split("/"))
        os.makedirs(dest_dir, exist_ok=True)
        dest = os.path.join(dest_dir, it["file"])
        if not os.path.exists(dest):
            if it["kind"] == "photo":
                subprocess.run(["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", resize, src, dest, "2560"], check=True)
            else:
                shutil.copy2(src, dest)
        print(f"[{n}/{len(items)}] {it['folder']}/{it['file']}")
    add_test_cases(library, items)
    write_licenses(library, items)
    print(f"Test library ready: {library}")


def add_test_cases(library, items):
    photos = [os.path.join(library, *i["folder"].split("/"), i["file"]) for i in items if i["kind"] == "photo"]
    cases = os.path.join(library, "Test cases")
    os.makedirs(cases, exist_ok=True)
    resize = os.path.join(HERE, "resize-keep-exif.ps1")
    # Find duplicates: an exact copy elsewhere, a smaller copy, and the same file under a phone-style name
    shutil.copy2(photos[0], os.path.join(cases, "exact copy of " + os.path.basename(photos[0])))
    small = os.path.join(cases, "resized copy of " + os.path.basename(photos[1]))
    if not os.path.exists(small):
        subprocess.run(["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", resize, photos[1], small, "1200"], check=True)
    shutil.copy2(photos[2], os.path.join(cases, "IMG_20260402_101500.jpg"))
    # Received through WhatsApp (named like WhatsApp saves them), and a picture without any EXIF
    shutil.copy2(photos[3], os.path.join(cases, "IMG-20260404-WA0007.jpg"))
    no_exif = os.path.join(cases, "no exif.jpg")
    if not os.path.exists(no_exif):
        subprocess.run(["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", resize, photos[4], no_exif, "1600", "-StripExif"], check=True)


def write_licenses(library, items):
    lines = ["# Licences of the Lumina test library", "",
             "NASA media: not copyrighted, see https://www.nasa.gov/nasa-brand-center/images-and-media/ "
             "(it may not be used to imply NASA endorsement).",
             "RAW samples: CC0 1.0, https://raw.pixls.us/.", "",
             "| File | Title | Credit | Licence | Source |", "| :--- | :--- | :--- | :--- | :--- |"]
    for it in items:
        lines.append(f"| {it['folder']}/{it['file']} | {it['title'].replace('|', '/')} | {it['credit']} | {it['license']} | {it['url']} |")
    with open(os.path.join(library, "LICENSES.md"), "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "select":
        select()
    elif len(sys.argv) > 1 and sys.argv[1] == "build":
        build(sys.argv[2] if len(sys.argv) > 2 else r"C:\LuminaTest\Library")
    else:
        print(__doc__)
