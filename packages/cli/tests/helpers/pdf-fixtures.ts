// 这层管：手写的最小 PDF 字节（页树 + 大纲树），给 `pdf-scan.test.ts` 当夹具；**仅测试用**。
//
// 不用真 Chrome 产物：真产物的字节会随 Chrome 版本漂，钉不住"页序/树/解码"这三件事；
// 手写的几份各钉一件——单条目、三层嵌套、无 `/Outlines`、多层页树、`/Kids` 与对象号逆序。
//
// 夹具只服务扫描器：`/Size`、`startxref` 是为"形态像 PDF"凑的，**不保证与 xref 自洽**，
// 也不带真正的内容流。别拿它们去喂 qpdf / pdftotext 这类严格校验器，会报错——那不是扫描器的 bug。

/** 三页骨架：Catalog(1) + Pages(2) + Page(3..)。引自页对象号从 3 起，`/Dest` 好对号。 */
export const pagesOf = (count: number): string => {
  const pages = Array.from(
    { length: count },
    (_unused: unknown, index: number) =>
      `${String(3 + index)} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] >>\nendobj\n`,
  ).join("");
  const kids = Array.from(
    { length: count },
    (_unused: unknown, index: number) => `${String(3 + index)} 0 R`,
  ).join(" ");
  return (
    "%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n" +
    `2 0 obj\n<< /Type /Pages /Count ${String(count)} /Kids [${kids}] >>\nendobj\n` +
    pages
  );
};

/** 给 Catalog 挂上 `/Outlines 10 0 R`：大纲根对象与条目都从 10 起。 */
export const withOutlinesOf = (body: string): string =>
  body.replace("/Type /Catalog /Pages 2 0 R", "/Type /Catalog /Pages 2 0 R /Outlines 10 0 R");

/** 经典 xref 的 trailer：`/Root` 只在这里出现，扫全文取第一个就是 Catalog。 */
export const trailerOf = (): string =>
  "trailer\n<< /Size 99 /Root 1 0 R >>\nstartxref\n0000\n%%EOF\n";

export const bytesOf = (body: string): Uint8Array => Buffer.from(`${body}${trailerOf()}`, "latin1");

/** 单条目：根(10) → 条目(11)，指向第 2 页。 */
export const SINGLE =
  "10 0 obj\n<< /Type /Outlines /First 11 0 R /Last 11 0 R /Count 1 >>\nendobj\n" +
  "11 0 obj\n<< /Title (Chapter One) /Parent 10 0 R /Dest [4 0 R /XYZ 0 800 0] >>\nendobj\n";

/**
 * 三层嵌套：根(10) → Part(11) → {Section A(12) → Sub A1(14)，第二层(13)}。
 * 兄弟顺序刻意与对象号顺序不同（12 → 13 靠 `/Next`，不是靠号大小）。
 */
export const NESTED =
  "10 0 obj\n<< /Type /Outlines /First 11 0 R /Last 11 0 R /Count 4 >>\nendobj\n" +
  "11 0 obj\n<< /Title (Part) /Parent 10 0 R /First 12 0 R /Last 13 0 R /Count 3 " +
  "/Dest [3 0 R /XYZ 0 800 0] >>\nendobj\n" +
  "12 0 obj\n<< /Title (Section A) /Parent 11 0 R /First 14 0 R /Last 14 0 R /Count 1 " +
  "/Next 13 0 R /Dest [4 0 R /XYZ 0 700 0] >>\nendobj\n" +
  "13 0 obj\n<< /Title <FEFF7B2C4E8C5C42> /Parent 11 0 R /Prev 12 0 R " +
  "/Dest [5 0 R /XYZ 0 600 0] >>\nendobj\n" +
  "14 0 obj\n<< /Title (Sub A1) /Parent 12 0 R /Dest [5 0 R /XYZ 0 500 0] >>\nendobj\n";

/**
 * 页树四层：Catalog(1) → Pages(2) → Pages(3) → Pages(6) → Page(4)、Page(5)。
 * 这两份页树夹具（本份与 `REVERSED_KIDS`）存在的**唯一理由**是钉住两个扫描器变异：
 * ① `/Kids` 只摊一层、或把中间 `/Pages` 也追加进页序（对象 3/6 一旦出现在 `pages` 里就是错的）；
 * ② 按对象号升序排（本份恰好与对象号同序，所以它只负责①，②交给 `REVERSED_KIDS`）。
 * 链路刻意做到四层：三层时\"只摊一层\"得到的仍是正确答案，够不着这个变异。
 */
export const CHAIN_PAGES =
  "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n" +
  "2 0 obj\n<< /Type /Pages /Count 2 /Kids [3 0 R] >>\nendobj\n" +
  "3 0 obj\n<< /Type /Pages /Parent 2 0 R /Count 2 /Kids [6 0 R] >>\nendobj\n" +
  "6 0 obj\n<< /Type /Pages /Parent 3 0 R /Count 2 /Kids [4 0 R 5 0 R] >>\nendobj\n" +
  "4 0 obj\n<< /Type /Page /Parent 6 0 R /MediaBox [0 0 595 842] >>\nendobj\n" +
  "5 0 obj\n<< /Type /Page /Parent 6 0 R /MediaBox [0 0 595 842] >>\nendobj\n";

/**
 * `/Kids [7 0 R 5 0 R]`：页序与对象号顺序**相反**（对象 5 在前、对象 7 在后）。
 * 把 `pageOrderOf` 改成\"按对象号排\"时只有这一份会红，所以别把 `/Kids` 改回升序。
 */
export const REVERSED_KIDS =
  "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n" +
  "2 0 obj\n<< /Type /Pages /Count 2 /Kids [7 0 R 5 0 R] >>\nendobj\n" +
  "5 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] >>\nendobj\n" +
  "7 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] >>\nendobj\n";
