#!/usr/bin/env python3
import json
import os
import re
import sys
from urllib.parse import urlparse, parse_qs
from urllib.request import Request, urlopen

# Config (can be overridden by CLI):
# --file <path>        input JSON (default: ../seed.lessons.json)
# --out <path>         output JSON (default: ../seed.lessons.local.json)
# --outdir <path>      images directory (default: ../imgs)

SAFE_EXTS = {'.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg'}


def argval(flag, default=None):
    if flag in sys.argv:
        i = sys.argv.index(flag)
        if i + 1 < len(sys.argv) and not sys.argv[i + 1].startswith('-'):
            return sys.argv[i + 1]
        return True
    return default


def slugify(text):
    text = text.strip().lower()
    text = re.sub(r'[^a-z0-9]+', '-', text)
    text = re.sub(r'-+', '-', text).strip('-')
    return text or 'img'


def guess_ext(url, content_type=None):
    # Try from URL path
    path = urlparse(url).path
    ext = os.path.splitext(path)[1].lower()
    if ext in SAFE_EXTS:
        return ext
    # Try query param 'format'
    qs = parse_qs(urlparse(url).query)
    fmt = (qs.get('format') or [''])[0].lower()
    if fmt:
        fmt = '.' + fmt
        if fmt in SAFE_EXTS:
            return fmt
    # Try content-type
    if content_type:
        if 'png' in content_type:
            return '.png'
        if 'jpeg' in content_type or 'jpg' in content_type:
            return '.jpg'
        if 'gif' in content_type:
            return '.gif'
        if 'webp' in content_type:
            return '.webp'
        if 'svg' in content_type:
            return '.svg'
    # Fallback
    return '.png'


def download(url, dest_path):
    headers = {
        'User-Agent': 'Mozilla/5.0 (compatible; CourseworkImageFetcher/1.0)'
    }
    req = Request(url, headers=headers)
    with urlopen(req, timeout=20) as resp:
        data = resp.read()
        with open(dest_path, 'wb') as f:
            f.write(data)
        ct = resp.headers.get('Content-Type', '')
        return ct


def main():
    root = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
    in_file = argval('--file', os.path.join(root, 'seed.lessons.json'))
    out_file = argval('--out', os.path.join(root, 'seed.lessons.local.json'))
    out_dir = argval('--outdir', os.path.join(root, 'imgs'))

    if not os.path.exists(in_file):
        print(f"Input JSON not found: {in_file}", file=sys.stderr)
        sys.exit(1)
    os.makedirs(out_dir, exist_ok=True)

    with open(in_file, 'r', encoding='utf-8') as f:
        docs = json.load(f)
    if not isinstance(docs, list):
        print('Input JSON must be an array', file=sys.stderr)
        sys.exit(1)

    used_names = set(os.listdir(out_dir))
    downloaded = 0
    for i, doc in enumerate(docs):
        url = doc.get('image')
        topic = doc.get('topic') or f'img-{i+1}'
        if not url or not isinstance(url, str) or not url.startswith(('http://', 'https://')):
            # leave as-is if not a URL
            continue
        base = slugify(topic)
        # Temp guess extension; we may refine after HEAD/GET
        ext = guess_ext(url)
        filename = f"{base}{ext}"
        # Ensure unique filename
        n = 1
        while filename in used_names:
            filename = f"{base}-{n}{ext}"
            n += 1
        dest_path = os.path.join(out_dir, filename)
        try:
            ct = download(url, dest_path)
            # If ext was wrong and content-type suggests better, we could rename (optional)
            used_names.add(filename)
            doc['image'] = f"/imgs/{filename}"
            downloaded += 1
            print(f"Saved {url} -> {doc['image']}")
        except Exception as e:
            print(f"Failed to download {url}: {e}", file=sys.stderr)
            # Keep original URL so frontend still works
            continue

    with open(out_file, 'w', encoding='utf-8') as f:
        json.dump(docs, f, ensure_ascii=False, indent=2)

    print(f"Done. Downloaded {downloaded} images. Wrote {out_file}.")


if __name__ == '__main__':
    main()
