#!/usr/bin/env python3
"""Generate the judge-facing one-page PrincipalLatch architecture diagram."""

from __future__ import annotations

import math
from pathlib import Path

from reportlab.lib.colors import HexColor
from reportlab.lib.pagesizes import A4, landscape
from reportlab.pdfbase.pdfmetrics import stringWidth
from reportlab.pdfgen.canvas import Canvas


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "output" / "pdf" / "PrincipalLatch_Architecture_One_Page.pdf"

BG = HexColor("#071723")
PANEL = HexColor("#0D2635")
PANEL_LIGHT = HexColor("#123646")
TEXT = HexColor("#EDF8F7")
MUTED = HexColor("#91AAB5")
LINE = HexColor("#2D5664")
TEAL = HexColor("#55D9C7")
GREEN = HexColor("#54D38A")
AMBER = HexColor("#F4B765")
RED = HexColor("#F16F7E")
WHITE = HexColor("#FFFFFF")


def rounded_panel(
    canvas: Canvas,
    x: float,
    y: float,
    width: float,
    height: float,
    *,
    fill=PANEL,
    stroke=LINE,
    radius: float = 9,
    line_width: float = 1,
    dashed: bool = False,
) -> None:
    canvas.saveState()
    canvas.setFillColor(fill)
    canvas.setStrokeColor(stroke)
    canvas.setLineWidth(line_width)
    if dashed:
        canvas.setDash(5, 4)
    canvas.roundRect(x, y, width, height, radius, stroke=1, fill=1)
    canvas.restoreState()


def label(
    canvas: Canvas,
    value: str,
    x: float,
    y: float,
    *,
    size: float = 8,
    color=TEXT,
    font: str = "Helvetica",
) -> None:
    canvas.setFillColor(color)
    canvas.setFont(font, size)
    canvas.drawString(x, y, value)


def centered(
    canvas: Canvas,
    value: str,
    center_x: float,
    y: float,
    *,
    size: float = 8,
    color=TEXT,
    font: str = "Helvetica",
) -> None:
    canvas.setFillColor(color)
    canvas.setFont(font, size)
    canvas.drawCentredString(center_x, y, value)


def wrapped_lines(value: str, font: str, size: float, max_width: float) -> list[str]:
    words = value.split()
    lines: list[str] = []
    current = ""
    for word in words:
        candidate = word if not current else current + " " + word
        if stringWidth(candidate, font, size) <= max_width:
            current = candidate
        else:
            if current:
                lines.append(current)
            current = word
    if current:
        lines.append(current)
    return lines


def wrapped(
    canvas: Canvas,
    value: str,
    x: float,
    y: float,
    max_width: float,
    *,
    size: float = 7.5,
    leading: float = 10,
    color=MUTED,
    font: str = "Helvetica",
    max_lines: int = 4,
) -> float:
    lines = wrapped_lines(value, font, size, max_width)[:max_lines]
    canvas.setFillColor(color)
    canvas.setFont(font, size)
    for index, line in enumerate(lines):
        canvas.drawString(x, y - index * leading, line)
    return y - len(lines) * leading


def pill(
    canvas: Canvas,
    value: str,
    x: float,
    y: float,
    *,
    color=TEAL,
    fill=PANEL_LIGHT,
    size: float = 6.5,
    padding_x: float = 8,
    height: float = 18,
) -> float:
    width = stringWidth(value, "Helvetica-Bold", size) + padding_x * 2
    canvas.setFillColor(fill)
    canvas.setStrokeColor(color)
    canvas.setLineWidth(0.7)
    canvas.roundRect(x, y, width, height, height / 2, stroke=1, fill=1)
    centered(
        canvas,
        value,
        x + width / 2,
        y + 5.3,
        size=size,
        color=color,
        font="Helvetica-Bold",
    )
    return width


def arrow(
    canvas: Canvas,
    start: tuple[float, float],
    end: tuple[float, float],
    *,
    color=TEAL,
    line_width: float = 1.5,
    dashed: bool = False,
) -> None:
    x1, y1 = start
    x2, y2 = end
    canvas.saveState()
    canvas.setStrokeColor(color)
    canvas.setFillColor(color)
    canvas.setLineWidth(line_width)
    if dashed:
        canvas.setDash(4, 3)
    canvas.line(x1, y1, x2, y2)
    angle = math.atan2(y2 - y1, x2 - x1)
    head = 6
    spread = 2.7
    left = (
        x2 - head * math.cos(angle) + spread * math.sin(angle),
        y2 - head * math.sin(angle) - spread * math.cos(angle),
    )
    right = (
        x2 - head * math.cos(angle) - spread * math.sin(angle),
        y2 - head * math.sin(angle) + spread * math.cos(angle),
    )
    path = canvas.beginPath()
    path.moveTo(x2, y2)
    path.lineTo(*left)
    path.lineTo(*right)
    path.close()
    canvas.drawPath(path, stroke=0, fill=1)
    canvas.restoreState()


def component(
    canvas: Canvas,
    x: float,
    y: float,
    width: float,
    height: float,
    eyebrow: str,
    title: str,
    details: list[str],
    *,
    accent=TEAL,
    dashed: bool = False,
) -> None:
    rounded_panel(
        canvas,
        x,
        y,
        width,
        height,
        fill=PANEL_LIGHT if not dashed else PANEL,
        stroke=accent,
        line_width=1.1,
        dashed=dashed,
    )
    canvas.setFillColor(accent)
    canvas.roundRect(x + 11, y + height - 27, 19, 19, 5, stroke=0, fill=1)
    centered(
        canvas,
        eyebrow[:2].upper(),
        x + 20.5,
        y + height - 21.2,
        size=5.5,
        color=BG,
        font="Helvetica-Bold",
    )
    label(canvas, eyebrow.upper(), x + 37, y + height - 18, size=6.1, color=accent, font="Helvetica-Bold")
    label(canvas, title, x + 11, y + height - 43, size=10.5, font="Helvetica-Bold")
    cursor = y + height - 58
    for detail in details:
        label(canvas, detail, x + 11, cursor, size=6.8, color=MUTED)
        cursor -= 10


def evidence_card(
    canvas: Canvas,
    x: float,
    y: float,
    width: float,
    number: str,
    heading: str,
    body: str,
    verdict: str,
    *,
    accent,
) -> None:
    rounded_panel(canvas, x, y, width, 70, fill=PANEL, stroke=LINE, radius=8)
    canvas.setFillColor(accent)
    canvas.circle(x + 17, y + 51, 9, stroke=0, fill=1)
    centered(canvas, number, x + 17, y + 48.2, size=7, color=BG, font="Helvetica-Bold")
    label(canvas, heading, x + 31, y + 52, size=7.5, font="Helvetica-Bold")
    wrapped(canvas, body, x + 12, y + 34, width - 24, size=6.2, leading=8, max_lines=2)
    label(canvas, verdict, x + 12, y + 9, size=6.4, color=accent, font="Helvetica-Bold")


def build() -> Path:
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    width, height = landscape(A4)
    canvas = Canvas(str(OUTPUT), pagesize=(width, height))
    canvas.setTitle("PrincipalLatch - One-Page Architecture")
    canvas.setAuthor("PrincipalLatch TechJam Team")
    canvas.setSubject("TikTok TechJam 2026 Track 1 Bouncer architecture and trust boundary")

    canvas.setFillColor(BG)
    canvas.rect(0, 0, width, height, stroke=0, fill=1)

    # Header
    canvas.setFillColor(TEAL)
    canvas.roundRect(28, height - 53, 28, 28, 7, stroke=0, fill=1)
    centered(canvas, "PL", 42, height - 43.4, size=8, color=BG, font="Helvetica-Bold")
    label(canvas, "PRINCIPALLATCH", 66, height - 35, size=16, font="Helvetica-Bold")
    label(
        canvas,
        "Verifiable Agent delegation and resource enforcement",
        66,
        height - 49,
        size=7.5,
        color=MUTED,
    )
    label(
        canvas,
        "TIKTOK TECHJAM 2026  |  TRACK 1: BOUNCER",
        510,
        height - 35,
        size=7.5,
        color=TEAL,
        font="Helvetica-Bold",
    )
    px = 510
    for value, color in [
        ("BACKEND ENFORCED", TEAL),
        ("REVOCABLE", AMBER),
        ("FAIL CLOSED", RED),
    ]:
        px += pill(canvas, value, px, height - 61, color=color) + 7

    # Browser principal.
    component(
        canvas,
        27,
        363,
        96,
        106,
        "Human",
        "Alice",
        ["user:alice", "only browser session", "Agent owner"],
    )
    component(
        canvas,
        27,
        252,
        96,
        90,
        "B",
        "Bob / User B",
        ["user:bob", "no browser session", "resource owner"],
        accent=RED,
    )

    # Trusted host boundary.
    rounded_panel(canvas, 143, 303, 671, 184, fill=HexColor("#0A202D"), stroke=TEAL, radius=12, line_width=1.3)
    label(canvas, "TRUSTED HOST BOUNDARY", 158, 472, size=6.4, color=TEAL, font="Helvetica-Bold")
    label(canvas, "secrets, authority, policy, audit and protected content stay here", 285, 472, size=6.2, color=MUTED)

    component(
        canvas,
        161,
        350,
        137,
        101,
        "Control",
        "AgentService",
        ["owns Agent lifecycle", "issues session Passport", "launches one Runtime turn"],
    )
    component(
        canvas,
        318,
        350,
        137,
        101,
        "Authority",
        "Current authority",
        ["signed delegation", "principal x Agent", "lifecycle + revision"],
        accent=AMBER,
    )
    component(
        canvas,
        475,
        350,
        137,
        101,
        "Gateway",
        "Authorization Gateway",
        ["derives action + owner", "verifies current authority", "audits decision/outcome"],
        accent=TEAL,
    )
    component(
        canvas,
        632,
        350,
        164,
        101,
        "Resource",
        "Protected provider",
        ["Alice: alice-doc-001", "Bob: bob-payroll-001", "called only after ALLOW"],
        accent=GREEN,
    )

    # Disposable Agent trust domain.
    component(
        canvas,
        294,
        211,
        253,
        75,
        "Runtime",
        "Disposable Codex Agent container",
        ["short-lived Passport + scoped mounts", "no signing key, authority store or raw provider data"],
        accent=AMBER,
        dashed=True,
    )
    label(canvas, "UNTRUSTED AGENT RUNTIME", 557, 250, size=6.2, color=AMBER, font="Helvetica-Bold")
    label(canvas, "one Agent owned by Alice", 557, 238, size=6.2, color=MUTED)

    # Trust flow.
    arrow(canvas, (123, 416), (161, 416))
    centered(canvas, "launch", 142, 425, size=5.5, color=MUTED, font="Helvetica-Bold")
    arrow(canvas, (298, 400), (318, 400), color=AMBER)
    centered(canvas, "bind", 308, 410, size=5.2, color=MUTED)
    arrow(canvas, (455, 400), (475, 400), color=AMBER)
    centered(canvas, "verify", 465, 410, size=5.2, color=MUTED)
    arrow(canvas, (612, 400), (632, 400), color=GREEN)
    centered(canvas, "ALLOW", 622, 410, size=5.2, color=GREEN, font="Helvetica-Bold")
    arrow(canvas, (229, 350), (341, 286), color=AMBER, dashed=True)
    label(canvas, "Passport + scoped Runtime", 174, 313, size=5.5, color=AMBER, font="Helvetica-Bold")
    arrow(canvas, (547, 249), (543, 350), color=TEAL)
    label(canvas, "resource ID + Passport", 554, 310, size=5.5, color=TEAL, font="Helvetica-Bold")

    # Audit contract strip.
    rounded_panel(canvas, 27, 174, 787, 24, fill=HexColor("#0B2230"), stroke=LINE, radius=7)
    label(canvas, "AUDIT CONTRACT", 40, 182, size=6.2, color=TEAL, font="Helvetica-Bold")
    label(
        canvas,
        "human  |  Agent  |  action  |  resource  |  decision  |  outcome  |  providerReadCount",
        132,
        182,
        size=7,
        color=TEXT,
        font="Helvetica-Bold",
    )
    label(canvas, "raw Passport and secrets never reach browser evidence", 598, 182, size=5.8, color=MUTED)

    # Required proof plus differentiating revocation.
    label(canvas, "JUDGE PROOF SEQUENCE", 28, 156, size=6.5, color=TEAL, font="Helvetica-Bold")
    card_width = 190
    evidence_card(
        canvas,
        27,
        74,
        card_width,
        "1",
        "Alice delegates",
        "Agent principal is owned by user:alice; one short-lived Passport is issued.",
        "BOUND HUMAN x AGENT",
        accent=TEAL,
    )
    evidence_card(
        canvas,
        226,
        74,
        card_width,
        "2",
        "Positive + negative",
        "Same Agent reads Alice, then attempts Bob without changing identity.",
        "ALLOW ALICE  |  DENY BOB",
        accent=GREEN,
    )
    evidence_card(
        canvas,
        425,
        74,
        card_width,
        "3",
        "Backend proves denial",
        "Bob provider is never called; decision and not_attempted outcome are audited.",
        "BOB PROVIDER READS = 0",
        accent=RED,
    )
    evidence_card(
        canvas,
        624,
        74,
        card_width,
        "4",
        "Live revocation",
        "Alice revokes the Mandate; the same unexpired Passport loses authority.",
        "DENY_MANDATE_LIFECYCLE",
        accent=AMBER,
    )

    label(
        canvas,
        "Official core: Alice/User A owns one Agent; Bob/User B owns negative-control data; backend proves allow/deny + audit.",
        28,
        51,
        size=6.2,
        color=MUTED,
    )
    label(canvas, "Runtime: real Codex CLI + Volcengine Ark in a disposable Docker/Podman container", 28, 29, size=6.2, color=TEXT, font="Helvetica-Bold")
    label(canvas, "Local judging path  |  npm run poc", 662, 29, size=6.2, color=TEAL, font="Helvetica-Bold")

    canvas.showPage()
    canvas.save()
    return OUTPUT


if __name__ == "__main__":
    print(build())
