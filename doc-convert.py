# -*- coding: utf-8 -*-
"""
Turn a file the owner attached on the board into text an agent can read cheaply.

WHY THIS EXISTS. The owner works with documents in whatever form they reach him: a PDF
manual, a Word specification, a spreadsheet, a slide deck, a web page saved to disk. Handed
to an agent as they are, each costs a tool chain to open and many times its worth in
tokens — and an agent that cannot open one simply guesses. The board converts every
attachment once, when it is attached, into plain Markdown next to the original, and the
message carries the path of that text.

    python doc-convert.py <input file> <output .md> [original name]

Prints one line of JSON: {"ok", "kind", "chars", "note", "needs_description"}.
Text-bearing formats are converted here, with the standard library (pypdf when it is
installed, for PDF). A picture, a video or a recording carries nothing a parser can read:
the output then holds what is known about the file, and "needs_description" asks the board
to have the supervisor describe it.

An archive (zip, tar, gz, bz2, xz, 7z, rar) is unpacked into a temporary folder and every
file in it is converted the same way, into one Markdown text. What a file is, is decided by
its first bytes, not by its name: an archive member called `data.bin` that is a PDF is read
as a PDF. Tools the standard library lacks are found by themselves — 7-Zip and LibreOffice
on Windows, `7z` and `pdftotext` inside WSL.

Never raises: an attachment that cannot be converted is still attached.
"""
import csv
import html
import io
import json
import os
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import zipfile
from xml.etree import ElementTree as ET

MAX_CHARS = 400000          # a text longer than this is cut, and says so
MAX_ROWS = 2000             # rows of one sheet or one csv
MAX_MEMBERS = 400           # files of one archive that are looked at
MAX_UNPACKED = 400 * 1024 * 1024   # bytes one archive may unpack to
MAX_MEMBER_CHARS = 60000    # text of one archive member
MAX_DEPTH = 2               # an archive inside an archive inside an archive
TOOL_TIMEOUT = 120

ARCHIVE_EXT = {".zip", ".7z", ".rar", ".tar", ".gz", ".tgz", ".bz2", ".tbz2", ".xz", ".txz", ".jar", ".apk"}
OLD_OFFICE = {".doc": "docx", ".xls": "xlsx", ".ppt": "pptx"}

TEXT_EXT = {".txt", ".md", ".markdown", ".log", ".ini", ".cfg", ".conf", ".toml", ".yaml", ".yml",
            ".json", ".xml", ".srt", ".vtt", ".tex", ".rst", ".diff", ".patch", ".properties", ".gradle"}
CODE_EXT = {".py", ".js", ".ts", ".tsx", ".jsx", ".java", ".kt", ".kts", ".c", ".h", ".cpp", ".hpp", ".cs",
            ".go", ".rs", ".rb", ".php", ".sh", ".bat", ".cmd", ".ps1", ".sql", ".smali", ".css", ".vbs", ".lua"}
IMAGE_EXT = {".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".tif", ".tiff", ".svg"}
MEDIA_EXT = {".mp4", ".mkv", ".webm", ".mov", ".avi", ".m4v", ".mp3", ".wav", ".ogg", ".m4a", ".flac", ".opus"}


def read_text(path):
    raw = open(path, "rb").read()
    for enc in ("utf-8-sig", "utf-16", "cp1251", "latin-1"):
        try:
            return raw.decode(enc)
        except UnicodeError:
            continue
    return raw.decode("utf-8", "replace")


def table(rows):
    """Rows of cells as a Markdown table; the first row is the header."""
    rows = [[str(c if c is not None else "").replace("|", "\\|").replace("\n", " ").strip() for c in r] for r in rows]
    rows = [r for r in rows if any(r)]
    if not rows:
        return ""
    width = max(len(r) for r in rows)
    rows = [r + [""] * (width - len(r)) for r in rows]
    out = ["| " + " | ".join(rows[0]) + " |", "|" + "---|" * width]
    out += ["| " + " | ".join(r) + " |" for r in rows[1:]]
    return "\n".join(out)


def local(tag):
    return tag.rsplit("}", 1)[-1]


# ── PDF ─────────────────────────────────────────────────────────────────────────

def pdf(path):
    try:
        from pypdf import PdfReader
    except ImportError:
        try:
            from PyPDF2 import PdfReader
        except ImportError:
            return None, "PDF text needs the pypdf package: python -m pip install pypdf"
    reader = PdfReader(path)
    parts, empty = [], 0
    for i, page in enumerate(reader.pages, 1):
        try:
            text = (page.extract_text() or "").strip()
        except Exception:
            text = ""
        if not text:
            empty += 1
            continue
        parts.append("## Page %d\n\n%s" % (i, text))
    note = ""
    if empty and not parts:
        return "", "the PDF has %d page(s) and no text layer — it is a scan" % len(reader.pages)
    if empty:
        note = "%d of %d page(s) carry no text (pictures or scans)" % (empty, len(reader.pages))
    return "\n\n".join(parts), note


# ── Office Open XML: a zip of XML parts ─────────────────────────────────────────

def docx(path):
    with zipfile.ZipFile(path) as z:
        root = ET.fromstring(z.read("word/document.xml"))
    body = next((e for e in root.iter() if local(e.tag) == "body"), root)

    def para(p):
        style = ""
        for e in p.iter():
            if local(e.tag) == "pStyle":
                style = next((v for k, v in e.attrib.items() if local(k) == "val"), "")
        bits = []
        for e in p.iter():
            name = local(e.tag)
            if name == "t":
                bits.append(e.text or "")
            elif name in ("tab",):
                bits.append("\t")
            elif name in ("br", "cr"):
                bits.append("\n")
        text = "".join(bits).strip()
        m = re.match(r"(?i)heading\s*(\d)", style or "")
        if text and m:
            return "#" * min(6, int(m.group(1)) + 1) + " " + text
        if text and re.match(r"(?i)title", style or ""):
            return "# " + text
        return text

    out = []
    for child in body:
        name = local(child.tag)
        if name == "p":
            t = para(child)
            if t:
                out.append(t)
        elif name == "tbl":
            rows = []
            for tr in (e for e in child.iter() if local(e.tag) == "tr"):
                rows.append([" ".join(para(p) for p in tc.iter() if local(p.tag) == "p").strip()
                             for tc in tr if local(tc.tag) == "tc"])
            out.append(table(rows))
    return "\n\n".join(o for o in out if o), ""


def xlsx(path):
    with zipfile.ZipFile(path) as z:
        names = z.namelist()
        shared = []
        if "xl/sharedStrings.xml" in names:
            for si in ET.fromstring(z.read("xl/sharedStrings.xml")):
                shared.append("".join(t.text or "" for t in si.iter() if local(t.tag) == "t"))
        titles = []
        if "xl/workbook.xml" in names:
            titles = [s.attrib.get("name", "") for s in ET.fromstring(z.read("xl/workbook.xml")).iter()
                      if local(s.tag) == "sheet"]
        sheets = sorted((n for n in names if re.match(r"xl/worksheets/sheet\d+\.xml$", n)),
                        key=lambda n: int(re.search(r"(\d+)\.xml$", n).group(1)))
        out, cut = [], False
        for idx, name in enumerate(sheets):
            rows = []
            for row in (e for e in ET.fromstring(z.read(name)).iter() if local(e.tag) == "row"):
                cells = []
                for c in (e for e in row if local(e.tag) == "c"):
                    ref = re.match(r"([A-Z]+)", c.attrib.get("r", "") or "")
                    col = 0
                    for ch in (ref.group(1) if ref else ""):
                        col = col * 26 + (ord(ch) - 64)
                    v = next((e for e in c if local(e.tag) == "v"), None)
                    inline = "".join(t.text or "" for t in c.iter() if local(t.tag) == "t")
                    val = inline
                    if v is not None and v.text is not None:
                        val = shared[int(v.text)] if c.attrib.get("t") == "s" and v.text.isdigit() and int(v.text) < len(shared) else v.text
                    while col and len(cells) < col - 1:
                        cells.append("")
                    cells.append(val)
                rows.append(cells)
                if len(rows) >= MAX_ROWS:
                    cut = True
                    break
            t = table(rows)
            if t:
                out.append("## %s\n\n%s" % (titles[idx] if idx < len(titles) and titles[idx] else "Sheet %d" % (idx + 1), t))
    return "\n\n".join(out), ("sheets are cut at %d rows" % MAX_ROWS) if cut else ""


def pptx(path):
    with zipfile.ZipFile(path) as z:
        slides = sorted((n for n in z.namelist() if re.match(r"ppt/slides/slide\d+\.xml$", n)),
                        key=lambda n: int(re.search(r"(\d+)\.xml$", n).group(1)))
        out = []
        for i, name in enumerate(slides, 1):
            paras = []
            for p in (e for e in ET.fromstring(z.read(name)).iter() if local(e.tag) == "p"):
                text = "".join(t.text or "" for t in p.iter() if local(t.tag) == "t").strip()
                if text:
                    paras.append(text)
            notes = "ppt/notesSlides/notesSlide%d.xml" % i
            if notes in z.namelist():
                n = " ".join(t.text or "" for t in ET.fromstring(z.read(notes)).iter() if local(t.tag) == "t").strip()
                if n:
                    paras.append("> Notes: " + n)
            out.append("## Slide %d\n\n%s" % (i, "\n\n".join(paras) if paras else "(no text)"))
    return "\n\n".join(out), ""


def odf(path):
    with zipfile.ZipFile(path) as z:
        root = ET.fromstring(z.read("content.xml"))
    out = []
    for e in root.iter():
        name = local(e.tag)
        if name in ("p", "h"):
            text = "".join(e.itertext()).strip()
            if text:
                out.append(("## " + text) if name == "h" else text)
    return "\n\n".join(out), ""


# ── the rest ────────────────────────────────────────────────────────────────────

def html_text(path):
    raw = read_text(path)
    try:
        from bs4 import BeautifulSoup
        soup = BeautifulSoup(raw, "html.parser")
        for t in soup(["script", "style", "noscript"]):
            t.decompose()
        text = soup.get_text("\n")
    except Exception:
        text = re.sub(r"(?is)<(script|style).*?</\1>", "", raw)
        text = html.unescape(re.sub(r"(?s)<[^>]+>", "\n", text))
    return re.sub(r"\n\s*\n\s*\n+", "\n\n", "\n".join(l.strip() for l in text.splitlines())).strip(), ""


def rtf(path):
    raw = read_text(path)
    raw = re.sub(r"\\'([0-9a-fA-F]{2})", lambda m: bytes([int(m.group(1), 16)]).decode("cp1251", "replace"), raw)
    raw = re.sub(r"\\u(-?\d+)\??", lambda m: chr(int(m.group(1)) % 65536), raw)
    raw = re.sub(r"\\par[d]?\b", "\n", raw)
    raw = re.sub(r"\{\\\*[^{}]*\}", "", raw)
    raw = re.sub(r"\\[a-zA-Z]+-?\d* ?", "", raw)
    return re.sub(r"[{}]", "", raw).strip(), "RTF is converted roughly: text only"


def delimited(path, sep):
    rows, cut = [], False
    for i, row in enumerate(csv.reader(io.StringIO(read_text(path)), delimiter=sep)):
        if i >= MAX_ROWS:
            cut = True
            break
        rows.append(row)
    return table(rows), ("cut at %d rows" % MAX_ROWS) if cut else ""


def image_facts(path):
    facts = []
    try:
        from PIL import Image
        with Image.open(path) as im:
            facts.append("%d x %d px, %s" % (im.width, im.height, im.format or ""))
    except Exception:
        pass
    return facts


# ── what a file is, by its first bytes ──────────────────────────────────────────

def sniff(path):
    """→ an extension the first bytes prove, or '' when they prove nothing."""
    try:
        with open(path, "rb") as fh:
            head = fh.read(560)
    except OSError:
        return ""
    if head.startswith(b"%PDF"):
        return ".pdf"
    if head.startswith(b"7z\xbc\xaf\x27\x1c"):
        return ".7z"
    if head.startswith(b"Rar!\x1a\x07"):
        return ".rar"
    if head.startswith(b"\x1f\x8b"):
        return ".gz"
    if head.startswith(b"BZh"):
        return ".bz2"
    if head.startswith(b"\xfd7zXZ\x00"):
        return ".xz"
    if head.startswith(b"{\\rtf"):
        return ".rtf"
    if head.startswith(b"\x89PNG"):
        return ".png"
    if head.startswith(b"\xff\xd8\xff"):
        return ".jpg"
    if head[:6] in (b"GIF87a", b"GIF89a"):
        return ".gif"
    if head[:4] == b"RIFF" and head[8:12] == b"WEBP":
        return ".webp"
    if head.startswith(b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1"):
        return ".ole"                                    # old Word / Excel / PowerPoint
    if len(head) > 262 and head[257:262] == b"ustar":
        return ".tar"
    if head.startswith(b"PK\x03\x04") or head.startswith(b"PK\x05\x06"):
        try:
            with zipfile.ZipFile(path) as z:
                names = set(z.namelist())
                if "word/document.xml" in names:
                    return ".docx"
                if "xl/workbook.xml" in names:
                    return ".xlsx"
                if "ppt/presentation.xml" in names:
                    return ".pptx"
                if "mimetype" in names:
                    kind = z.read("mimetype").decode("ascii", "replace")
                    for mark, ext in (("opendocument.text", ".odt"), ("opendocument.spreadsheet", ".ods"),
                                      ("opendocument.presentation", ".odp")):
                        if mark in kind:
                            return ext
        except Exception:
            pass
        return ".zip"
    return ""


def kind_ext(path, name=None):
    """The extension to convert by: the name's when it is one the converter knows and the
    bytes do not contradict it, otherwise what the bytes say."""
    ext = os.path.splitext(name or path)[1].lower()
    lower = (name or path).lower()
    if lower.endswith((".tar.gz", ".tar.bz2", ".tar.xz")):
        return ".tgz"
    seen = sniff(path)
    if not seen:
        return ext
    if seen == ".ole":
        return ext if ext in OLD_OFFICE else ".ole"
    if seen == ".zip":
        return ext if ext in (".jar", ".apk", ".docm", ".xlsm", ".ppsx", ".zip") else ".zip"
    if seen in (".gz", ".bz2", ".xz") and ext in (".tgz", ".tbz2", ".txz"):
        return ext
    if seen == ".jpg" and ext == ".jpeg":
        return ext
    return seen


# ── tools outside the standard library, found by themselves ───────────────────────

def run(cmd, timeout=TOOL_TIMEOUT):
    flags = 0x08000000 if os.name == "nt" else 0         # no console window
    return subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout, creationflags=flags)


def wsl_path(path):
    path = os.path.abspath(path)
    drive, rest = os.path.splitdrive(path)
    if len(drive) == 2 and drive[1] == ":":
        return "/mnt/" + drive[0].lower() + rest.replace("\\", "/")
    return path.replace("\\", "/")


_wsl = {}

def wsl_has(tool):
    """True when WSL is there and has the tool."""
    if os.name != "nt":
        return False
    if tool not in _wsl:
        try:
            r = run(["wsl.exe", "-e", "sh", "-c", "command -v " + tool], timeout=25)
            _wsl[tool] = r.returncode == 0 and bool(r.stdout.strip())
        except Exception:
            _wsl[tool] = False
    return _wsl[tool]


def find_exe(names, places):
    for n in names:
        hit = shutil.which(n)
        if hit:
            return hit
    for place in places:
        if os.path.isfile(place):
            return place
    return None


def seven_zip():
    roots = [os.environ.get("ProgramFiles", r"C:\Program Files"), os.environ.get("ProgramFiles(x86)", r"C:\Program Files (x86)")]
    return find_exe(["7z", "7za", "7zz"], [os.path.join(r, "7-Zip", "7z.exe") for r in roots if r])


def soffice():
    roots = [os.environ.get("ProgramFiles", r"C:\Program Files"), os.environ.get("ProgramFiles(x86)", r"C:\Program Files (x86)")]
    return find_exe(["soffice", "libreoffice"], [os.path.join(r, "LibreOffice", "program", "soffice.exe") for r in roots if r])


def pdftotext(path):
    """The text layer by poppler, where pypdf found none or is not installed. → text or ''."""
    try:
        exe = shutil.which("pdftotext")
        if exe:
            r = run([exe, "-layout", "-enc", "UTF-8", path, "-"])
        elif wsl_has("pdftotext"):
            r = run(["wsl.exe", "-e", "pdftotext", "-layout", "-enc", "UTF-8", wsl_path(path), "-"])
        else:
            return ""
        return r.stdout.decode("utf-8", "replace").strip() if r.returncode == 0 else ""
    except Exception:
        return ""


def old_office(path, ext, depth):
    """.doc / .xls / .ppt: LibreOffice rewrites it in the XML format, which is then read here."""
    exe = soffice()
    if not exe:
        return "office", "", "an old Office format; LibreOffice is needed to read it and was not found", True
    target = OLD_OFFICE.get(ext)
    tmp = tempfile.mkdtemp(prefix="board_office_")
    try:
        for fmt in ([target] if target else ["docx", "xlsx", "pptx"]):
            try:
                run([exe, "--headless", "--norestore", "--convert-to", fmt, "--outdir", tmp, path])
            except Exception:
                continue
            made = [f for f in os.listdir(tmp) if f.lower().endswith("." + fmt)]
            if made:
                kind, text, note, needs = convert_as(os.path.join(tmp, made[0]), "." + fmt, depth)
                return kind, text, ("read through LibreOffice" + ("; " + note if note else "")), needs
        return "office", "", "LibreOffice could not convert it", True
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


# ── archives ────────────────────────────────────────────────────────────────────────

def inside(root, name):
    """The path of an archive member under root, or None when the name leads out of it."""
    name = name.replace("\\", "/")
    if not name or name.startswith("/") or re.match(r"^[A-Za-z]:", name):
        return None
    parts = [x for x in name.split("/") if x not in ("", ".")]
    if not parts or ".." in parts:
        return None
    dest = os.path.abspath(os.path.join(root, *parts))
    return dest if dest.startswith(os.path.abspath(root) + os.sep) else None


def unpack_zip(path, root):
    skipped = 0
    with zipfile.ZipFile(path) as z:
        infos = [i for i in z.infolist() if not i.is_dir()]
        total = 0
        for i in infos[:MAX_MEMBERS]:
            dest = inside(root, i.filename)
            total += i.file_size
            if dest is None or total > MAX_UNPACKED or i.flag_bits & 1:      # unsafe name, too big, encrypted
                skipped += 1
                continue
            os.makedirs(os.path.dirname(dest), exist_ok=True)
            with z.open(i) as src, open(dest, "wb") as out:
                shutil.copyfileobj(src, out, 1 << 20)
        skipped += max(0, len(infos) - MAX_MEMBERS)
    return skipped


def unpack_tar(path, root):
    skipped = 0
    with tarfile.open(path) as t:
        total = count = 0
        for m in t:
            if not m.isfile():                            # links and devices are never unpacked
                skipped += 0 if m.isdir() else 1
                continue
            count += 1
            dest = inside(root, m.name)
            total += m.size
            if dest is None or total > MAX_UNPACKED or count > MAX_MEMBERS:
                skipped += 1
                continue
            os.makedirs(os.path.dirname(dest), exist_ok=True)
            src = t.extractfile(m)
            if src is None:
                skipped += 1
                continue
            with src, open(dest, "wb") as out:
                shutil.copyfileobj(src, out, 1 << 20)
    return skipped


def unpack_single(path, root, name, opener):
    """.gz / .bz2 / .xz of one file."""
    inner = os.path.splitext(os.path.basename(name))[0] or "content"
    dest = os.path.join(root, re.sub(r"[^\w.\- ]", "_", inner))
    done = 0
    with opener(path, "rb") as src, open(dest, "wb") as out:
        while True:
            chunk = src.read(1 << 20)
            if not chunk:
                break
            done += len(chunk)
            if done > MAX_UNPACKED:
                raise ValueError("unpacks to more than %d MB" % (MAX_UNPACKED >> 20))
            out.write(chunk)
    return 0


def unpack_7z(path, root):
    """7z and rar, and anything else 7-Zip opens. Windows 7-Zip first, then 7z inside WSL."""
    exe = seven_zip()
    if exe:
        lst = [exe, "l", "-slt", "-ba", "-p", path]
        ext = [exe, "x", "-y", "-p", "-snl-", "-o" + root, path]
    elif wsl_has("7z"):
        lst = ["wsl.exe", "-e", "7z", "l", "-slt", "-ba", "-p", wsl_path(path)]
        ext = ["wsl.exe", "-e", "7z", "x", "-y", "-p", "-o" + wsl_path(root), wsl_path(path)]
    else:
        raise ValueError("7-Zip is needed to open it and was not found (neither on Windows nor in WSL)")
    listing = run(lst).stdout.decode("utf-8", "replace")
    sizes = [int(x) for x in re.findall(r"^Size = (\d+)", listing, re.M)]
    names = re.findall(r"^Path = (.+)$", listing, re.M)
    if sum(sizes) > MAX_UNPACKED:
        raise ValueError("unpacks to more than %d MB" % (MAX_UNPACKED >> 20))
    if len(names) > MAX_MEMBERS * 5:
        raise ValueError("holds %d entries, too many to unpack" % len(names))
    if any(inside(root, n.strip()) is None for n in names):
        raise ValueError("holds a path that leads outside the archive")
    r = run(ext)
    if r.returncode not in (0, 1):                        # 1 = warnings
        raise ValueError("7-Zip could not unpack it (exit %d)" % r.returncode)
    return 0


def archive(path, ext, name, depth):
    if depth >= MAX_DEPTH:
        return "archive", "", "an archive nested too deep to unpack", False
    tmp = tempfile.mkdtemp(prefix="board_unpack_")
    try:
        try:
            if ext in (".zip", ".jar", ".apk"):
                skipped = unpack_zip(path, tmp)
            elif ext in (".tar", ".tgz", ".tbz2", ".txz"):
                skipped = unpack_tar(path, tmp)
            elif ext in (".gz", ".bz2", ".xz"):
                import bz2, gzip, lzma
                opener = {".gz": gzip.open, ".bz2": bz2.open, ".xz": lzma.open}[ext]
                skipped = unpack_single(path, tmp, name, opener)
            else:
                skipped = unpack_7z(path, tmp)
        except Exception as e:
            return "archive", "", "could not be unpacked: %s" % e, False

        files = []
        root = os.path.abspath(tmp)
        for folder, dirs, names in os.walk(root):
            dirs[:] = sorted(d for d in dirs if not os.path.islink(os.path.join(folder, d)))
            for n in sorted(names):
                full = os.path.join(folder, n)
                if os.path.islink(full) or not os.path.isfile(full):
                    continue
                files.append(full)
        more = max(0, len(files) - MAX_MEMBERS)
        files = files[:MAX_MEMBERS]

        index, parts, undescribed = [], [], 0
        for full in files:
            rel = os.path.relpath(full, root).replace("\\", "/")
            size = os.path.getsize(full)
            try:
                kind, text, note, needs = convert(full, depth + 1)
            except Exception as e:
                kind, text, note, needs = "unreadable", "", "could not be converted: %s" % e, False
            text = (text or "").replace("\r\n", "\n").strip()
            if len(text) > MAX_MEMBER_CHARS:
                text = text[:MAX_MEMBER_CHARS]
                note = (note + "; " if note else "") + "cut at %d characters" % MAX_MEMBER_CHARS
            if kind in ("image", "media", "binary") or (needs and not text):
                undescribed += 1
            index.append("| %s | %s | %d | %s |" % (rel.replace("|", "\\|"), kind, size, (note or "").replace("|", "\\|")))
            if text:
                # a member's own headings go one level down, under the member's heading
                text = re.sub(r"^(#{1,5}) ", r"#\1 ", text, flags=re.M)
                parts.append("## %s\n\n%s" % (rel, text))
        head = ["Archive contents — %d file(s):" % len(files), "", "| file | kind | bytes | note |", "|---|---|---|---|"] + index
        notes = []
        if skipped:
            notes.append("%d member(s) skipped (unsafe path, encrypted, a link, or past the size limit)" % skipped)
        if more:
            notes.append("%d more file(s) not looked at" % more)
        if undescribed:
            notes.append("%d file(s) carry no text (pictures, media, binaries) and are only listed" % undescribed)
        return "archive", "\n".join(head) + ("\n\n" + "\n\n".join(parts) if parts else ""), "; ".join(notes), False
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def convert(path, depth=0, name=None):
    """→ (kind, text, note, needs_description). `name` is the name the owner gave the file."""
    return convert_as(path, kind_ext(path, name), depth, name)


def convert_as(path, ext, depth=0, name=None):
    if ext in ARCHIVE_EXT:
        return archive(path, ext, name or path, depth)
    if ext in OLD_OFFICE or ext == ".ole":
        return old_office(path, ext, depth)
    if ext == ".pdf":
        text, note = pdf(path)
        if not (text or "").strip():
            other = pdftotext(path)
            if other:
                return "pdf", other, "text taken by pdftotext", False
        if text is None:
            return "pdf", "", note, False
        return "pdf", text, note, not text.strip()
    if ext in (".docx", ".docm"):
        return ("docx",) + docx(path) + (False,)
    if ext in (".xlsx", ".xlsm"):
        return ("xlsx",) + xlsx(path) + (False,)
    if ext in (".pptx", ".ppsx"):
        return ("pptx",) + pptx(path) + (False,)
    if ext in (".odt", ".ods", ".odp"):
        return ("odf",) + odf(path) + (False,)
    if ext in (".html", ".htm", ".xhtml", ".mhtml"):
        return ("html",) + html_text(path) + (False,)
    if ext == ".rtf":
        return ("rtf",) + rtf(path) + (False,)
    if ext == ".csv":
        return ("csv",) + delimited(path, ",") + (False,)
    if ext == ".tsv":
        return ("tsv",) + delimited(path, "\t") + (False,)
    if ext in TEXT_EXT:
        return "text", read_text(path), "", False
    if ext in CODE_EXT:
        return "code", "```%s\n%s\n```" % (ext[1:], read_text(path)), "", False
    if ext in IMAGE_EXT:
        return "image", "\n".join(image_facts(path)), "", True
    if ext in MEDIA_EXT:
        return "media", "", "", True
    # Unknown: text if it reads as text, otherwise only what is known about it.
    raw = open(path, "rb").read(65536)
    if b"\x00" not in raw:
        try:
            raw.decode("utf-8")
            return "text", read_text(path), "", False
        except UnicodeError:
            pass
    return "binary", "", "a format the board does not convert", True


def main():
    if len(sys.argv) < 3:
        print(json.dumps({"ok": False, "note": "usage: doc-convert.py <input> <output.md>"}))
        return 0
    src, dst = sys.argv[1], sys.argv[2]
    name = sys.argv[3] if len(sys.argv) > 3 else os.path.basename(src)
    try:
        kind, text, note, needs = convert(src, 0, name)
    except Exception as e:                                # a broken file is still an attachment
        kind, text, note, needs = "unreadable", "", "could not be converted: %s" % e, True
    text = (text or "").replace("\r\n", "\n").strip()
    cut = len(text) > MAX_CHARS
    if cut:
        text = text[:MAX_CHARS]
        note = (note + "; " if note else "") + "cut at %d characters" % MAX_CHARS
    size = os.path.getsize(src) if os.path.exists(src) else 0
    head = ["# %s" % name, "",
            "> Converted by the board from `%s` (%s, %d bytes).%s" % (src, kind, size, (" " + note[0].upper() + note[1:] + ".") if note else "")]
    if needs:
        head += ["", "## Description", "",
                 "_Not described yet. This file carries nothing a parser can read as text; the board has asked the "
                 "supervisor to describe it here._"]
    body = "\n".join(head) + ("\n\n" + text if text else "") + "\n"
    try:
        os.makedirs(os.path.dirname(os.path.abspath(dst)), exist_ok=True)
        with io.open(dst, "w", encoding="utf-8", newline="\n") as fh:
            fh.write(body)
    except OSError as e:
        print(json.dumps({"ok": False, "note": "cannot write %s: %s" % (dst, e)}))
        return 0
    print(json.dumps({"ok": True, "kind": kind, "chars": len(text), "note": note, "needs_description": bool(needs)},
                     ensure_ascii=False))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as e:                                # never the board's problem
        print(json.dumps({"ok": False, "note": str(e)}))
        sys.exit(0)
