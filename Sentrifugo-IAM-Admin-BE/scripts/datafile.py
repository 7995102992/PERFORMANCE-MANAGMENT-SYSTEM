"""Shared data-file reader for the migration scripts.

Reads a tabular file as a list of dict rows keyed by the header row, accepting
EITHER `.csv` OR `.xlsx/.xlsm/.xls` — so every migration script can be pointed at
whichever format the export happens to be, via a path passed on the command line.

CSV  -> values are strings (csv.DictReader, BOM-tolerant).
Excel-> values are the cells' native types (datetime, int, ...), matching what the
        scripts' date/flag parsers already expect; the first sheet is used, or a
        sheet named 'Data' if present.
"""
from __future__ import annotations

import csv
from datetime import date, datetime
from pathlib import Path


def find_file(data_dir, includes, exclude: str | None = None):
    """Find the one data file in `data_dir` whose name contains any of `includes`
    (case-insensitive), skipping names containing `exclude`. Only .csv/.xlsx are
    considered. If several match, prefer .xlsx then the last by name (newest date
    in date-suffixed exports). Raises if none match."""
    d = Path(data_dir)
    if not d.is_dir():
        raise NotADirectoryError(f"data dir not found: {d}")
    if isinstance(includes, str):
        includes = [includes]
    out = []
    for f in sorted(d.iterdir()):
        if not f.is_file() or f.suffix.lower() not in (".csv", ".xlsx", ".xlsm", ".xls"):
            continue
        name = f.name.lower()
        if exclude and exclude.lower() in name:
            continue
        if any(inc.lower() in name for inc in includes):
            out.append(f)
    if not out:
        raise FileNotFoundError(f"no file matching {includes} in {d}")
    if len(out) > 1:
        xlsx = [f for f in out if f.suffix.lower() == ".xlsx"]
        out = xlsx or out
        chosen = out[-1]
        print(f"[datafile] {len(out)} files match {includes} in {d.name} "
              f"({[f.name for f in out]}) -> using {chosen.name}")
        return chosen
    return out[0]


def read_rows(path, sheet: str | None = None) -> list[dict]:
    """Return the file's rows as a list of {header: value} dicts."""
    p = Path(path)
    if not p.exists():
        raise FileNotFoundError(f"data file not found: {p}")
    if p.suffix.lower() in (".xlsx", ".xlsm", ".xls"):
        return _read_excel(p, sheet)
    return _read_csv(p)


def _read_csv(p: Path) -> list[dict]:
    with open(p, encoding="utf-8-sig", newline="") as f:
        return list(csv.DictReader(f))


def _cell(v):
    """Render an Excel cell as a CSV-like string so downstream parsers (which
    were written for csv string values) work unchanged. None -> "", dates ->
    ISO text, whole-number floats -> int text."""
    if v is None:
        return ""
    if isinstance(v, datetime):
        return v.isoformat(sep=" ")
    if isinstance(v, date):
        return v.isoformat()
    if isinstance(v, float) and v.is_integer():
        return str(int(v))
    return str(v)


def _read_excel(p: Path, sheet: str | None) -> list[dict]:
    from openpyxl import load_workbook
    wb = load_workbook(p, read_only=True, data_only=True)
    if sheet and sheet in wb.sheetnames:
        ws = wb[sheet]
    elif "Data" in wb.sheetnames:
        ws = wb["Data"]
    else:
        ws = wb[wb.sheetnames[0]]
    it = ws.iter_rows(values_only=True)
    header = [str(h).strip() if h is not None else "" for h in next(it)]
    rows: list[dict] = []
    for r in it:
        if r is None or all(c is None for c in r):
            continue
        rows.append({header[i]: _cell(r[i] if i < len(r) else None) for i in range(len(header))})
    wb.close()
    return rows
