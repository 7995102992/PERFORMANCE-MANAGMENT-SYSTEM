"""Payslip PDF (Sentrifugo / Sagarsoft layout), encrypted with the employee PIN.

reportlab is imported lazily so the service boots without it; the export endpoint
raises a clear error if the dependency is missing. The ₹ glyph needs a Unicode
font — one is registered when available, otherwise amounts fall back to "Rs.".
"""

from __future__ import annotations

import base64
import html
import io
import os

from src.payslips.schemas import PayslipRead

__all__ = ["build_payslip_pdf", "build_payslip_pdf_old", "build_payslip_html"]

_MONTHS = [
    "",
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
]

# Employer block (single-tenant for now; can later come from the organisation).
_COMPANY_NAME = "Sagarsoft (India) Ltd."
_COMPANY_ADDRESS = [
    "Plot #111 , Road Number 10, ICRISAT",
    "Colony, Jubilee Hills, Hyderabad,",
    "Telangana, 500045",
]
_COMPANY_LOGO_PATH = os.path.join(os.path.dirname(__file__), "assets", "logo.png")

# (regular, bold, regular-path, bold-path) — first existing wins; gives us the ₹ glyph.
_DEJAVU = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"
_DEJAVU_B = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
_FONT_CANDIDATES = [
    ("PdfBody", "PdfBodyB", _DEJAVU, _DEJAVU_B),
    ("PdfBody", "PdfBodyB", r"C:\Windows\Fonts\arial.ttf", r"C:\Windows\Fonts\arialbd.ttf"),
]

_ONES = [
    "",
    "One",
    "Two",
    "Three",
    "Four",
    "Five",
    "Six",
    "Seven",
    "Eight",
    "Nine",
    "Ten",
    "Eleven",
    "Twelve",
    "Thirteen",
    "Fourteen",
    "Fifteen",
    "Sixteen",
    "Seventeen",
    "Eighteen",
    "Nineteen",
]
_TENS = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"]


def _below_hundred(n: int) -> str:
    if n < 20:
        return _ONES[n]
    return (_TENS[n // 10] + (" " + _ONES[n % 10] if n % 10 else "")).strip()


def _below_thousand(n: int) -> str:
    if n < 100:
        return _below_hundred(n)
    rem = n % 100
    return (_ONES[n // 100] + " Hundred" + (" " + _below_hundred(rem) if rem else "")).strip()


def _number_words(value: float | int | None) -> str:
    """Whole number in Indian-English words, e.g. 'Twelve Thousand Two Hundred Seventy'."""
    n = int(round(abs(float(value or 0))))
    if n == 0:
        return "Zero"
    crore, n = divmod(n, 10_000_000)
    lakh, n = divmod(n, 100_000)
    thousand, hundreds = divmod(n, 1_000)
    parts = []
    if crore:
        parts.append(_below_thousand(crore) + " Crore")
    if lakh:
        parts.append(_below_hundred(lakh) + " Lakh")
    if thousand:
        parts.append(_below_hundred(thousand) + " Thousand")
    if hundreds:
        parts.append(_below_thousand(hundreds))
    return " ".join(parts)


def _amount_in_words(value: float | int | None) -> str:
    """Rupee amount in words, e.g. 'Rupees Twelve Thousand ... and Four Paise Only'."""
    n = abs(float(value or 0))
    rupees = int(n)
    paise = int(round((n - rupees) * 100))
    if paise == 100:
        rupees, paise = rupees + 1, 0
    if paise:
        return f"Rupees {_number_words(rupees)} and {_number_words(paise)} Paise Only"
    return f"Rupees {_number_words(rupees)} Only"


def _indian_group(whole: int) -> str:
    s = str(whole)
    if len(s) <= 3:
        return s
    last3, rest = s[-3:], s[:-3]
    groups: list[str] = []
    while len(rest) > 2:
        groups.insert(0, rest[-2:])
        rest = rest[:-2]
    if rest:
        groups.insert(0, rest)
    return ",".join(groups) + "," + last3


def _build_payslip(payslip: PayslipRead, *, password: str, display_name: str | None, show_ytd: bool) -> bytes:
    """Render the payslip to an encrypted PDF (modern Sagarsoft layout).

    ``show_ytd`` adds the year-to-date column to the earnings/deductions tables —
    on for the current template, off for the legacy (<= May 2026) one. The two
    templates are otherwise identical; legacy-only earning lines (uniform,
    telephone, magazines) simply appear when present and are hidden when zero.
    """
    try:
        from reportlab.lib import colors, pdfencrypt
        from reportlab.lib.pagesizes import A4
        from reportlab.lib.styles import ParagraphStyle
        from reportlab.lib.units import mm
        from reportlab.lib.utils import ImageReader
        from reportlab.pdfbase import pdfmetrics
        from reportlab.pdfbase.ttfonts import TTFont
        from reportlab.platypus import HRFlowable, Image, Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle
    except ImportError as exc:  # dependency not installed yet
        raise RuntimeError("reportlab is required for PDF export — run `pip install reportlab`.") from exc

    # Register a Unicode font for ₹; fall back to the built-in font + "Rs.".
    body, bold, rupee = "Helvetica", "Helvetica-Bold", "Rs. "
    for reg, regb, path, bpath in _FONT_CANDIDATES:
        if os.path.exists(path):
            try:
                pdfmetrics.registerFont(TTFont(reg, path))
                pdfmetrics.registerFont(TTFont(regb, bpath if os.path.exists(bpath) else path))
                body, bold, rupee = reg, regb, "₹"
                break
            except Exception:  # registration failed -> keep the built-in font
                continue

    def money(value: float | int | None) -> str:
        n = abs(float(value or 0))
        whole = int(n)
        paise = round((n - whole) * 100)
        if paise == 100:
            whole, paise = whole + 1, 0
        return f"{rupee}{_indian_group(whole)}.{paise:02d}"

    ink = colors.HexColor("#11023B")
    accent = colors.HexColor("#16A34A")  # net-pay accent (green)
    muted = colors.HexColor("#6B7280")
    line = colors.HexColor("#E5E7EB")
    band = colors.HexColor("#F3F4F6")

    p_addr_r = ParagraphStyle("ar", fontName=body, fontSize=8, textColor=muted, leading=11, alignment=2)
    p_company_r = ParagraphStyle("cn", fontName=bold, fontSize=11.5, textColor=ink, leading=14, alignment=2)
    p_title = ParagraphStyle("h", fontName=body, fontSize=11, textColor=ink, leading=15, alignment=1)
    p_days = ParagraphStyle("sd", fontName=body, fontSize=9, textColor=muted, leading=13, alignment=1)
    p_label = ParagraphStyle("l", fontName=body, fontSize=8.5, textColor=muted, leading=13)
    p_val = ParagraphStyle("v", fontName=body, fontSize=8.5, textColor=ink, leading=13)
    p_net_label = ParagraphStyle("nl", fontName=body, fontSize=9, textColor=muted, leading=13)
    p_net = ParagraphStyle("net", fontName=body, fontSize=11, textColor=ink, leading=18)
    p_foot = ParagraphStyle("f", fontName=body, fontSize=7.5, textColor=muted, alignment=1)

    month_name = _MONTHS[payslip.month] if 1 <= payslip.month <= 12 else str(payslip.month)
    period = f"{month_name} {payslip.year}"
    std_days = payslip.standard_days if payslip.standard_days is not None else "—"
    days_worked = payslip.days_worked if payslip.days_worked is not None else "—"
    story: list = []

    # ── Header: logo | period + attendance | company block ───────────────────
    if os.path.exists(_COMPANY_LOGO_PATH):
        image_reader = ImageReader(_COMPANY_LOGO_PATH)
        img_width, img_height = image_reader.getSize()
        max_width = 30 * mm
        logo = Image(
            _COMPANY_LOGO_PATH, width=max_width, height=img_height * (max_width / float(img_width)), hAlign="LEFT"
        )
    else:
        logo = Spacer(1, 1)

    center_cell = [
        Paragraph(f'Payslip For the Month <font name="{bold}">{period}</font>', p_title),
        Spacer(1, 1.5 * mm),
        Paragraph(f"Standard Days : {std_days}&nbsp;&nbsp;|&nbsp;&nbsp;Days Worked : {days_worked}", p_days),
    ]
    company_cell = [Paragraph(_COMPANY_NAME, p_company_r), Paragraph("<br/>".join(_COMPANY_ADDRESS), p_addr_r)]
    header = Table([[logo, center_cell, company_cell]], colWidths=[33 * mm, 82 * mm, 59 * mm])
    header.setStyle(TableStyle([("VALIGN", (0, 0), (-1, -1), "MIDDLE")]))
    story += [header, Spacer(1, 4 * mm), HRFlowable(width="100%", color=line, thickness=0.8), Spacer(1, 4 * mm)]

    # ── Employee + statutory (label : value, two columns) ────────────────────
    left = [
        ("Employee ID", payslip.emp_code),
        ("Employee Name", display_name or payslip.full_name or "—"),
        ("Designation", payslip.designation or "—"),
        ("Department", "—"),  # not stored on the payslip
        ("Date of Joining", payslip.date_of_joining or "—"),
    ]
    right = [
        ("Bank Name", payslip.bank_name or "—"),
        ("Bank Acc Number", payslip.account_no or "—"),
        ("PAN", payslip.pan_no or "—"),
        ("PF A/C Number", payslip.pf_no or "—"),
        ("UAN", payslip.uan_number or "—"),
        ("Aadhar Number", "—"),  # not stored on the payslip
    ]
    rows = []
    for i in range(max(len(left), len(right))):
        ll, lv = left[i] if i < len(left) else ("", "")
        rl, rv = right[i] if i < len(right) else ("", "")
        rows.append(
            [
                Paragraph(ll, p_label),
                Paragraph(f":&nbsp;&nbsp;{lv}" if ll else "", p_val),
                Paragraph(rl, p_label),
                Paragraph(f":&nbsp;&nbsp;{rv}" if rl else "", p_val),
            ]
        )
    info = Table(rows, colWidths=[28 * mm, 59 * mm, 31 * mm, 56 * mm])
    info.setStyle(
        TableStyle(
            [
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ("TOPPADDING", (0, 0), (-1, -1), 2),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 2),
            ]
        )
    )
    story += [info, Spacer(1, 3 * mm), HRFlowable(width="100%", color=line, thickness=0.6), Spacer(1, 4 * mm)]

    # ── Earnings / deductions ────────────────────────────────────────────────
    e, d, x = payslip.earnings, payslip.deductions, (payslip.extra or {})
    earn_src = [
        ("Basic Salary", e.basic_salary, x.get("basic_ytd")),
        ("HRA", e.hra, x.get("hra_ytd")),
        ("Uniform Allowance", e.uniform_allowance, None),
        ("Telephone / Mobile", e.telephone_or_mobile, None),
        ("Magazines", e.magazines, None),
        ("LTA", e.LTA, x.get("lta_ytd")),
        ("Retention Incentive", e.retention_incentive, None),
        ("Arrears", e.arrears, x.get("arrears_ytd")),
        ("Incentive / Project Allowance", e.incentive_or_project_allowwance, x.get("incentive_projects_allowance_ytd")),
    ]
    ded_src = [
        ("Income tax", d.income_tax, x.get("income_tax_ytd")),
        ("Provident Fund", d.provident_fund, x.get("provident_fund_ytd")),
        ("Professional Tax", d.professional_tax, x.get("professional_tax_ytd")),
        ("ESI", d.esi, None),
        ("Other Deductions", d.other_deductions, None),
        ("Salary Advance", d.salary_advance, x.get("salary_advance_ytd")),
        ("Health Insurance", d.health_insurance_premium, x.get("health_insurance_premium_ytd")),
        ("GMC Premium", d.gmc_premium, x.get("gmc_premium_ytd")),
    ]

    def _component_table(title: str, total_label: str, src: list, total: float | None) -> Table:
        head = ParagraphStyle("ch", fontName=bold, fontSize=8.5, textColor=ink)
        head_r = ParagraphStyle("chr", parent=head, alignment=2)
        cell = ParagraphStyle("cc", fontName=body, fontSize=8.5, textColor=ink, leading=12)
        amt = ParagraphStyle("ca", parent=cell, alignment=2)
        header_row = [Paragraph(title.upper(), head), Paragraph("AMOUNT", head_r)]
        if show_ytd:
            header_row.append(Paragraph("YTD", head_r))
        data = [header_row]
        for label, value, ytd in src:
            if not value and not (show_ytd and ytd):  # hide empty rows (keep if a YTD exists)
                continue
            row = [Paragraph(label, cell), Paragraph(money(value), amt)]
            if show_ytd:
                row.append(Paragraph(money(ytd or 0), amt))
            data.append(row)
        total_row = [Paragraph(total_label, head), Paragraph(money(total), head_r)]
        if show_ytd:
            total_row.append(Paragraph("", cell))
        data.append(total_row)
        tbl = Table(data, colWidths=[38 * mm, 25 * mm, 21 * mm] if show_ytd else [52 * mm, 32 * mm])
        last = len(data) - 1
        tbl.setStyle(
            TableStyle(
                [
                    ("BACKGROUND", (0, 0), (-1, 0), band),
                    ("LINEABOVE", (0, last), (-1, last), 0.8, line),
                    ("TOPPADDING", (0, 0), (-1, -1), 4),
                    ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
                    ("LEFTPADDING", (0, 0), (-1, -1), 6),
                    ("RIGHTPADDING", (0, 0), (-1, -1), 6),
                    ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
                ]
            )
        )
        return tbl

    earn_tbl = _component_table("Earnings", "Total Earnings", earn_src, e.total)
    ded_tbl = _component_table("Deducations", "Total Deductions", ded_src, d.total)
    grid = Table([[earn_tbl, ded_tbl]], colWidths=[87 * mm, 87 * mm])
    grid.setStyle(
        TableStyle(
            [
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ("LEFTPADDING", (0, 0), (-1, -1), 0),
                ("RIGHTPADDING", (0, 0), (0, 0), 6),
            ]
        )
    )
    story += [grid]

    # ── Total Net Pay (bottom, accented, with amount in words) ───────────────
    net = payslip.total
    story += [Spacer(1, 8 * mm), HRFlowable(width="100%", color=line, thickness=0.6, dash=(2, 2)), Spacer(1, 3 * mm)]
    net_cell = [
        Paragraph("Total Net Pay", p_net_label),
        Paragraph(
            f'<font name="{bold}" size="15" color="#16A34A">{money(net)}</font>'
            f'&nbsp;&nbsp;<font color="#11023B">({_amount_in_words(net)})</font>',
            p_net,
        ),
    ]
    banner = Table([[net_cell]], colWidths=[174 * mm])
    banner.setStyle(
        TableStyle(
            [
                ("LINEBEFORE", (0, 0), (0, -1), 3, accent),
                ("LEFTPADDING", (0, 0), (-1, -1), 8),
                ("TOPPADDING", (0, 0), (-1, -1), 4),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
            ]
        )
    )
    story += [banner, Spacer(1, 3 * mm), HRFlowable(width="100%", color=line, thickness=0.6, dash=(2, 2))]
    story += [
        Spacer(1, 4 * mm),
        Paragraph(
            "This Payslip has been automatically generated by Sentrifugo and does not "
            "require a physical or digital signature.",
            p_foot,
        ),
    ]

    enc = pdfencrypt.StandardEncryption(userPassword=password, canPrint=1)
    buffer = io.BytesIO()
    SimpleDocTemplate(
        buffer,
        pagesize=A4,
        encrypt=enc,
        leftMargin=15 * mm,
        rightMargin=15 * mm,
        topMargin=15 * mm,
        bottomMargin=15 * mm,
        title=f"Payslip {period}",
    ).build(story)
    return buffer.getvalue()


def build_payslip_pdf(payslip: PayslipRead, *, password: str, display_name: str | None = None) -> bytes:
    """Render the current payslip (with YTD column) to a PIN-encrypted PDF."""
    return _build_payslip(payslip, password=password, display_name=display_name, show_ytd=True)


def build_payslip_pdf_old(payslip: PayslipRead, *, password: str, display_name: str | None = None) -> bytes:
    """Render the legacy (<= May 2026) payslip — same layout, without the YTD column."""
    return _build_payslip(payslip, password=password, display_name=display_name, show_ytd=False)


def _logo_data_uri() -> str | None:
    """The company logo as a base64 ``data:`` URI, so the HTML view is self-contained."""
    if not os.path.exists(_COMPANY_LOGO_PATH):
        return None
    try:
        with open(_COMPANY_LOGO_PATH, "rb") as handle:
            return "data:image/png;base64," + base64.b64encode(handle.read()).decode("ascii")
    except OSError:
        return None


def _html_money(value: float | int | None) -> str:
    """Rupee amount as HTML text, e.g. ``₹12,270.04`` (₹ is a literal Unicode char)."""
    n = abs(float(value or 0))
    whole = int(n)
    paise = round((n - whole) * 100)
    if paise == 100:
        whole, paise = whole + 1, 0
    return f"₹{_indian_group(whole)}.{paise:02d}"


_HTML_STYLE = """
*{box-sizing:border-box}
.payslip{font-family:Arial,Helvetica,sans-serif;color:#11023B;max-width:820px;margin:0 auto;padding:24px;
  background:#fff;font-size:13px;line-height:1.4}
.ps-head{display:flex;align-items:center;justify-content:space-between;gap:16px}
.ps-head .logo{height:42px}
.ps-head .center{text-align:center;flex:1}
.ps-head .center .title{font-size:15px}
.ps-head .center .days{color:#6B7280;font-size:12px;margin-top:4px}
.ps-head .company{text-align:right}
.ps-head .company .name{font-weight:bold;font-size:15px}
.ps-head .company .addr{color:#6B7280;font-size:11px;line-height:1.35}
.rule{border:0;border-top:1px solid #E5E7EB;margin:14px 0}
.rule.dashed{border-top:1px dashed #E5E7EB}
.info{width:100%;border-collapse:collapse}
.info td{padding:3px 4px;vertical-align:top}
.info .lbl{color:#6B7280;width:22%}
.info .sep{color:#6B7280;width:2%}
.info .val{width:26%}
.grid{display:flex;gap:18px;margin-top:6px}
.comp{flex:1;border-collapse:collapse;font-size:12.5px}
.comp th,.comp td{padding:6px 8px;text-align:left}
.comp thead th{background:#F3F4F6;font-weight:bold}
.comp .amt{text-align:right;white-space:nowrap}
.comp tfoot td{border-top:1px solid #E5E7EB;font-weight:bold}
.netpay{border-left:3px solid #16A34A;padding:6px 0 6px 12px;margin:6px 0}
.netpay .netlabel{color:#6B7280;font-size:12px}
.netpay .amount{color:#16A34A;font-weight:bold;font-size:18px}
.netpay .words{color:#11023B;font-size:13px}
.foot{color:#6B7280;font-size:11px;text-align:center;margin-top:10px}
"""


def build_payslip_html(payslip: PayslipRead, *, display_name: str | None = None, show_ytd: bool = True) -> str:
    """Render the payslip as a self-contained HTML document (same layout as the PDF).

    Unlike the PDF this is unencrypted — it's served to the already-authenticated
    employee for an on-screen view. ``show_ytd`` toggles the year-to-date column
    (off for legacy <= May 2026 payslips).
    """
    esc = html.escape
    money = _html_money

    month_name = _MONTHS[payslip.month] if 1 <= payslip.month <= 12 else str(payslip.month)
    period = f"{month_name} {payslip.year}"
    std_days = payslip.standard_days if payslip.standard_days is not None else "—"
    days_worked = payslip.days_worked if payslip.days_worked is not None else "—"

    logo = _logo_data_uri()
    logo_html = f'<img class="logo" src="{logo}" alt="Sagarsoft"/>' if logo else "<span></span>"
    addr_html = "<br/>".join(esc(line) for line in _COMPANY_ADDRESS)

    left = [
        ("Employee ID", payslip.emp_code),
        ("Employee Name", display_name or payslip.full_name or "—"),
        ("Designation", payslip.designation or "—"),
        ("Department", "—"),  # not stored on the payslip
        ("Date of Joining", payslip.date_of_joining or "—"),
    ]
    right = [
        ("Bank Name", payslip.bank_name or "—"),
        ("Bank Acc Number", payslip.account_no or "—"),
        ("PAN", payslip.pan_no or "—"),
        ("PF A/C Number", payslip.pf_no or "—"),
        ("UAN", payslip.uan_number or "—"),
        ("Aadhar Number", "—"),  # not stored on the payslip
    ]
    info_rows = ""
    for i in range(max(len(left), len(right))):
        ll, lv = left[i] if i < len(left) else ("", "")
        rl, rv = right[i] if i < len(right) else ("", "")
        info_rows += (
            "<tr>"
            f'<td class="lbl">{esc(ll)}</td><td class="sep">{":" if ll else ""}</td><td class="val">{esc(str(lv))}</td>'
            f'<td class="lbl">{esc(rl)}</td><td class="sep">{":" if rl else ""}</td><td class="val">{esc(str(rv))}</td>'
            "</tr>"
        )

    e, d, x = payslip.earnings, payslip.deductions, (payslip.extra or {})
    earn_src = [
        ("Basic Salary", e.basic_salary, x.get("basic_ytd")),
        ("HRA", e.hra, x.get("hra_ytd")),
        ("Uniform Allowance", e.uniform_allowance, None),
        ("Telephone / Mobile", e.telephone_or_mobile, None),
        ("Magazines", e.magazines, None),
        ("LTA", e.LTA, x.get("lta_ytd")),
        ("Retention Incentive", e.retention_incentive, None),
        ("Arrears", e.arrears, x.get("arrears_ytd")),
        ("Incentive / Project Allowance", e.incentive_or_project_allowwance, x.get("incentive_projects_allowance_ytd")),
    ]
    ded_src = [
        ("Income tax", d.income_tax, x.get("income_tax_ytd")),
        ("Provident Fund", d.provident_fund, x.get("provident_fund_ytd")),
        ("Professional Tax", d.professional_tax, x.get("professional_tax_ytd")),
        ("ESI", d.esi, None),
        ("Other Deductions", d.other_deductions, None),
        ("Salary Advance", d.salary_advance, x.get("salary_advance_ytd")),
        ("Health Insurance", d.health_insurance_premium, x.get("health_insurance_premium_ytd")),
        ("GMC Premium", d.gmc_premium, x.get("gmc_premium_ytd")),
    ]

    def comp_table(title: str, total_label: str, src: list, total: float | int | None) -> str:
        ytd_head = '<th class="amt">YTD</th>' if show_ytd else ""
        body = ""
        for label, value, ytd in src:
            if not value and not (show_ytd and ytd):  # hide empty rows (keep if a YTD exists)
                continue
            ytd_cell = f'<td class="amt">{money(ytd or 0)}</td>' if show_ytd else ""
            body += f"<tr><td>{esc(label)}</td><td class='amt'>{money(value)}</td>{ytd_cell}</tr>"
        ytd_total = "<td></td>" if show_ytd else ""
        return (
            f'<table class="comp"><thead><tr><th>{esc(title.upper())}</th>'
            f'<th class="amt">AMOUNT</th>{ytd_head}</tr></thead>'
            f"<tbody>{body}</tbody>"
            f'<tfoot><tr><td>{esc(total_label)}</td><td class="amt">{money(total)}</td>{ytd_total}</tr></tfoot></table>'
        )

    earnings_html = comp_table("Earnings", "Total Earnings", earn_src, e.total)
    deductions_html = comp_table("Deducations", "Total Deductions", ded_src, d.total)
    net = payslip.total

    return (
        "<!DOCTYPE html><html lang='en'><head><meta charset='utf-8'/>"
        f"<title>Payslip {esc(period)}</title><style>{_HTML_STYLE}</style></head><body>"
        '<div class="payslip">'
        '<div class="ps-head">'
        f"{logo_html}"
        f'<div class="center"><div class="title">Payslip For the Month <b>{esc(period)}</b></div>'
        f'<div class="days">Standard Days : {esc(str(std_days))} &nbsp;|&nbsp; Days Worked : {esc(str(days_worked))}</div></div>'
        f'<div class="company"><div class="name">{esc(_COMPANY_NAME)}</div><div class="addr">{addr_html}</div></div>'
        "</div>"
        '<hr class="rule"/>'
        f'<table class="info">{info_rows}</table>'
        '<hr class="rule"/>'
        f'<div class="grid">{earnings_html}{deductions_html}</div>'
        '<hr class="rule dashed"/>'
        f'<div class="netpay"><div class="netlabel">Total Net Pay</div>'
        f'<div><span class="amount">{money(net)}</span> '
        f'<span class="words">({esc(_amount_in_words(net))})</span></div></div>'
        '<hr class="rule dashed"/>'
        '<div class="foot">This Payslip has been automatically generated by Sentrifugo and '
        "does not require a physical or digital signature.</div>"
        "</div></body></html>"
    )
