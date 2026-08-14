"""提取 PDF 页面文本；无文字层的页面渲染为 PNG 供外部视觉模型识别。

用法: python extract_pdf.py <pdf路径>
输出: JSON {pages: [{index, has_text, text}], images: [{index, png}]}
工作目录: 输出目录（PNG 写当前目录）
"""
import json
import sys

import pymupdf


def main() -> None:
    pdf_path = sys.argv[1]
    doc = pymupdf.open(pdf_path)  # 加密 PDF 也可打开（无用户密码时）
    result: dict = {"pages": [], "images": []}
    for i, page in enumerate(doc):
        text = page.get_text().strip()
        if len(text) > 30:
            result["pages"].append({"index": i, "has_text": True, "text": text[:8000]})
        else:
            png = f"_pdf_page_{i}.png"
            page.get_pixmap(dpi=150).save(png)
            result["pages"].append({"index": i, "has_text": False, "text": ""})
            result["images"].append({"index": i, "png": png})
    doc.close()
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
