from pathlib import Path
import re
from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.lib.utils import ImageReader
from reportlab.platypus import BaseDocTemplate, Flowable, Frame, KeepTogether, PageTemplate, Paragraph, Table, TableStyle

ROOT = Path(__file__).resolve().parent
SOURCE, PHOTO, OUTPUT = ROOT / "resume-en.md", ROOT / "favicon.ico", ROOT / "resume-en.pdf"
BLUE, CYAN, TEXT, MUTED, RULE = (colors.HexColor(value) for value in ("#123B5D", "#168AAD", "#24313A", "#596773", "#D6E1E8"))

base = ParagraphStyle("base", parent=getSampleStyleSheet()["BodyText"], fontName="Helvetica", fontSize=7.6, leading=9.15, textColor=TEXT, spaceAfter=1.3)
STYLES = {
    "name": ParagraphStyle("name", parent=base, fontName="Helvetica-Bold", fontSize=21, leading=22, alignment=TA_CENTER, textColor=BLUE, spaceAfter=1),
    "tagline": ParagraphStyle("tagline", parent=base, fontName="Helvetica-Bold", fontSize=9.8, leading=11.5, alignment=TA_CENTER, textColor=CYAN, spaceAfter=2),
    "contact": ParagraphStyle("contact", parent=base, fontSize=7.6, leading=9, alignment=TA_CENTER, textColor=MUTED, spaceAfter=1),
    "section": ParagraphStyle("section", parent=base, fontName="Helvetica-Bold", fontSize=10.7, leading=12.4, textColor=BLUE, spaceBefore=6.1, spaceAfter=2.5),
    "role": ParagraphStyle("role", parent=base, fontName="Helvetica-Bold", fontSize=8.25, leading=9.7, spaceBefore=4.2, spaceAfter=.5),
    "affiliation": ParagraphStyle("affiliation", parent=base, fontName="Helvetica-BoldOblique", fontSize=7.2, leading=8.4, textColor=BLUE, spaceAfter=.35),
    "meta": ParagraphStyle("meta", parent=base, fontName="Helvetica-Oblique", fontSize=7.1, leading=8.2, textColor=MUTED, spaceAfter=.6),
    "bullet": ParagraphStyle("bullet", parent=base, leftIndent=8, firstLineIndent=-5, bulletIndent=1.5, spaceAfter=.45),
    "numbered": ParagraphStyle("numbered", parent=base, leftIndent=9, firstLineIndent=-9, spaceAfter=.55),
}


class CircularPhoto(Flowable):
    def __init__(self, path, size):
        super().__init__()
        self.image, self.size = ImageReader(str(path)), size
        self.width = self.height = size

    def draw(self):
        canvas = self.canv
        image_width, image_height = self.image.getSize()
        scale = max(self.size / image_width, self.size / image_height)
        width, height = image_width * scale, image_height * scale
        x, y = (self.size - width) / 2, (self.size - height) / 2
        canvas.saveState()
        path = canvas.beginPath()
        path.circle(self.size / 2, self.size / 2, self.size / 2)
        canvas.clipPath(path, stroke=0, fill=0)
        canvas.drawImage(self.image, x, y, width=width, height=height, mask="auto")
        canvas.restoreState()
        canvas.setStrokeColor(CYAN)
        canvas.setLineWidth(.8)
        canvas.circle(self.size / 2, self.size / 2, self.size / 2 - .4, stroke=1, fill=0)


def markup(value):
    value = value.replace("&", "&amp;")
    value = re.sub(r"\*\*(.+?)\*\*", r"<b>\1</b>", value)
    return re.sub(r"(?<!\*)\*([^*]+?)\*", r"<i>\1</i>", value)


lines, story, index = SOURCE.read_text(encoding="utf-8").splitlines(), [], 0
while index < len(lines):
    line = lines[index].strip()
    if not line:
        index += 1
        continue
    if line.startswith("# "):
        name = Paragraph(markup(line[2:]), STYLES["name"])
        index += 1
        while not lines[index].strip(): index += 1
        tagline = Paragraph(markup(lines[index].strip()), STYLES["tagline"])
        index += 1
        while not lines[index].strip(): index += 1
        contact = Paragraph(markup(lines[index].strip()), STYLES["contact"])
        # Keep the text block centered relative to the page, not the space left after the avatar.
        header = Table([[CircularPhoto(PHOTO, 46), [name, tagline, contact], ""]], colWidths=[54, 401, 54], hAlign="CENTER")
        header.setStyle(TableStyle([("VALIGN", (0, 0), (-1, -1), "MIDDLE"), ("LEFTPADDING", (0, 0), (-1, -1), 0), ("RIGHTPADDING", (0, 0), (-1, -1), 0), ("TOPPADDING", (0, 0), (-1, -1), 0), ("BOTTOMPADDING", (0, 0), (-1, -1), 1)]))
        story.append(header)
    elif line.startswith("## "):
        story.append(Paragraph(markup(line[3:].upper()), STYLES["section"]))
    elif line.startswith("### "):
        block, next_index = [Paragraph(markup(line[4:]), STYLES["role"])], index + 1
        while next_index < len(lines) and not lines[next_index].strip(): next_index += 1
        if next_index < len(lines) and not lines[next_index].lstrip().startswith(("#", "-", "1.")):
            next_line = lines[next_index].strip()
            next_index += 1
            if "–" not in next_line and "|" not in next_line:
                block.append(Paragraph(markup(next_line), STYLES["affiliation"]))
                while next_index < len(lines) and not lines[next_index].strip(): next_index += 1
                if next_index < len(lines):
                    block.append(Paragraph(markup(lines[next_index].strip()), STYLES["meta"]))
                    index = next_index
            else:
                block.append(Paragraph(markup(next_line), STYLES["meta"]))
                index = next_index
        story.append(KeepTogether(block))
    elif re.match(r"^\d+\. ", line):
        story.append(Paragraph(markup(line), STYLES["numbered"]))
    elif line.startswith("- "):
        story.append(Paragraph("• " + markup(line[2:]), STYLES["bullet"]))
    else:
        story.append(Paragraph(markup(line), base))
    index += 1


def page_chrome(canvas, doc):
    canvas.saveState()
    width, height = A4
    canvas.setStrokeColor(RULE)
    canvas.setLineWidth(.5)
    canvas.line(15 * mm, height - 11 * mm, width - 15 * mm, height - 11 * mm)
    canvas.line(15 * mm, 10 * mm, width - 15 * mm, 10 * mm)
    canvas.setFont("Helvetica", 6.8)
    canvas.setFillColor(MUTED)
    canvas.drawString(15 * mm, 6.2 * mm, "Youwei Huang · https://www.devil.ren/")
    canvas.drawRightString(width - 15 * mm, 6.2 * mm, str(doc.page))
    canvas.restoreState()


document = BaseDocTemplate(str(OUTPUT), pagesize=A4, leftMargin=15 * mm, rightMargin=15 * mm, topMargin=14 * mm, bottomMargin=13 * mm, title="Youwei Huang - Resume", author="Youwei Huang")
document.addPageTemplates(PageTemplate(id="resume", frames=[Frame(document.leftMargin, document.bottomMargin, document.width, document.height, id="resume")], onPage=page_chrome))
document.build(story)
print(OUTPUT)
