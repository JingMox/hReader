// 这层管：手写的最小 PDF 字节（页树 + 大纲树），给 `pdf-scan.test.ts` 与 `pdf-bookmarks.test.ts` 当夹具；**仅测试用**。
//
// 不用真 Chrome 产物：真产物的字节会随 Chrome 版本漂，钉不住"页序/树/解码"这三件事；
// 手写的几份各钉一件——单条目、三层嵌套、无 `/Outlines`、多层页树、`/Kids` 与对象号逆序。
//
// `OUTLINE_*` 那几份是大纲条数的陷阱夹具：根对象自报数与实际结构**刻意**不一致（或本就无结构），
// 用来钉 "不许直接信 `/Count`、不许断链回退 0"；每份的口径见各自注释。
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

/**
 * trailer 里也挂 `/Info 30 0 R`：真实 Chrome 产物里 `/Info` 字典自己有一条 `/Title`，
 * 所以"数 `/Title` 出现次数"会恒多 1；本夹具的对象 30 就是那个陷阱。
 */
export const bytesWithInfoOf = (body: string): Uint8Array =>
  Buffer.from(
    `${body}30 0 obj\n<< /Title (Doc Title) >>\nendobj\n` +
      "trailer\n<< /Size 99 /Root 1 0 R /Info 30 0 R >>\nstartxref\n0000\n%%EOF\n",
    "latin1",
  );

/** 完整产物字节：页树 + `count` 条同级大纲条目（`count` 为 0 时根本没有 `/Outlines` 键）。 */
export const pdfWithBookmarksOf = (count: number): Uint8Array => {
  if (count === 0) return bytesOf(pagesOf(1));
  const refs = Array.from({ length: count }, (_unused: unknown, index: number) =>
    String(11 + index),
  );
  const items = refs
    .map((id: string, index: number) => {
      const next = refs[index + 1];
      const link = next === undefined ? "" : ` /Next ${next} 0 R`;
      return (
        `${id} 0 obj\n<< /Title (H${String(index + 1)}) /Parent 10 0 R${link}` +
        " /Dest [3 0 R /XYZ 0 800 0] >>\nendobj\n"
      );
    })
    .join("");
  const root =
    `10 0 obj\n<< /Type /Outlines /First 11 0 R /Last ${refs.at(-1) ?? ""} 0 R ` +
    `/Count ${String(count)} >>\nendobj\n`;
  return bytesOf(withOutlinesOf(pagesOf(1)) + root + items);
};

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

/** 两条同级：11 → 12 靠 `/Next`；12 是链尾（没有 `/Next`）。不跟 `/Next` 只数得到 1。 */
export const OUTLINE_TWO_SIBLINGS =
  "10 0 obj\n<< /Type /Outlines /First 11 0 R /Last 12 0 R /Count 2 >>\nendobj\n" +
  "11 0 obj\n<< /Title (One) /Parent 10 0 R /Next 12 0 R /Dest [3 0 R /XYZ 0 800 0] >>\nendobj\n" +
  "12 0 obj\n<< /Title (Two) /Parent 10 0 R /Prev 11 0 R /Dest [4 0 R /XYZ 0 700 0] >>\nendobj\n";

/** 根自报 `/Count 3`、实际只有 2 条：产物自相矛盾，取任何一个都是在撒谎。 */
export const OUTLINE_COUNT_LIE =
  "10 0 obj\n<< /Type /Outlines /First 11 0 R /Last 12 0 R /Count 3 >>\nendobj\n" +
  "11 0 obj\n<< /Title (One) /Parent 10 0 R /Next 12 0 R /Dest [3 0 R /XYZ 0 800 0] >>\nendobj\n" +
  "12 0 obj\n<< /Title (Two) /Parent 10 0 R /Prev 11 0 R /Dest [4 0 R /XYZ 0 700 0] >>\nendobj\n";

/** 根不带 `/Count`（规范里它可选）：答案只能来自实走。 */
export const OUTLINE_NO_COUNT =
  "10 0 obj\n<< /Type /Outlines /First 11 0 R /Last 11 0 R >>\nendobj\n" +
  "11 0 obj\n<< /Title (Only) /Parent 10 0 R /Dest [3 0 R /XYZ 0 800 0] >>\nendobj\n";

/** 根的 `/Count` 为负（折叠态写法）：与实走做核对时必须取绝对值。 */
export const OUTLINE_FOLDED_COUNT =
  "10 0 obj\n<< /Type /Outlines /First 11 0 R /Last 11 0 R /Count -1 >>\nendobj\n" +
  "11 0 obj\n<< /Title (Only) /Parent 10 0 R /Dest [3 0 R /XYZ 0 800 0] >>\nendobj\n";

/** `/First` 指向不存在的对象 99：断链，必须报错而不是回退 0。 */
export const OUTLINE_BROKEN_FIRST =
  "10 0 obj\n<< /Type /Outlines /First 99 0 R /Last 99 0 R /Count 1 >>\nendobj\n";

/** `/First` 指向的对象体不是字典：同上，不许当\"空目录\"读过去。 */
export const OUTLINE_NOT_A_DICTIONARY =
  "10 0 obj\n<< /Type /Outlines /First 99 0 R /Last 99 0 R /Count 1 >>\nendobj\n" +
  "99 0 obj\n42\nendobj\n";

/** 自环：11 的 `/Next` 指回自己。没有环检测就是死循环。 */
export const OUTLINE_SELF_LOOP =
  "10 0 obj\n<< /Type /Outlines /First 11 0 R /Last 11 0 R /Count 1 >>\nendobj\n" +
  "11 0 obj\n<< /Title (Loop) /Parent 10 0 R /Next 11 0 R /Dest [3 0 R /XYZ 0 800 0] >>\nendobj\n";

/**
 * 标题字面量里就写着 PDF 结构：`(endobj)`、`(/First 99 0 R /Next 77 0 R /Count 999)`、
 * `(a \( b \) c (嵌套) 50% trailer << /Root 98 0 R >>)`。真 Chrome 会把用户标题原样写进
 * `/Title`，所以这不是恶意产物，是**合法文档**；在原文上 grep `/Next` 或按 `endobj` 切对象，
 * 这份产物就会报"`/Count` 自报 3 条，实走 1 条"甚至整份落不了盘。
 */
export const OUTLINE_HOSTILE_TITLES =
  "10 0 obj\n<< /Type /Outlines /First 11 0 R /Last 13 0 R /Count 3 >>\nendobj\n" +
  "11 0 obj\n<< /Title (endobj) /Parent 10 0 R /Next 12 0 R /Dest [3 0 R /XYZ 0 800 0] >>\nendobj\n" +
  "12 0 obj\n<< /Title (/First 99 0 R /Next 77 0 R /Count 999) /Parent 10 0 R " +
  "/Next 13 0 R /Dest [4 0 R /XYZ 0 700 0] >>\nendobj\n" +
  "13 0 obj\n<< /Title (a \\( b \\) c (nested (deep)) 50% trailer << /Root 98 0 R >>) " +
  "/Parent 10 0 R /Dest [5 0 R /XYZ 0 600 0] >>\nendobj\n";

/**
 * 嵌套与同级**混着来**且 `/Count` 与实走一致（共 5 条：A{A1,A2} 与 B{B1}）。
 * 只摊一层、只走兄弟、或把 `/Next` 当子层，任一种变异都会在这里红，不必靠 `/Count` 报错来兜。
 */
export const OUTLINE_MIXED_NESTED_AND_SIBLINGS =
  "10 0 obj\n<< /Type /Outlines /First 11 0 R /Last 14 0 R /Count 5 >>\nendobj\n" +
  "11 0 obj\n<< /Title (A) /Parent 10 0 R /First 12 0 R /Last 13 0 R /Count 2 " +
  "/Next 14 0 R /Dest [3 0 R /XYZ 0 800 0] >>\nendobj\n" +
  "12 0 obj\n<< /Title (A1) /Parent 11 0 R /Next 13 0 R /Dest [3 0 R /XYZ 0 700 0] >>\nendobj\n" +
  "13 0 obj\n<< /Title (A2) /Parent 11 0 R /Dest [4 0 R /XYZ 0 600 0] >>\nendobj\n" +
  "14 0 obj\n<< /Title (B) /Parent 10 0 R /First 15 0 R /Last 15 0 R /Count 1 " +
  "/Dest [5 0 R /XYZ 0 500 0] >>\nendobj\n" +
  "15 0 obj\n<< /Title (B1) /Parent 14 0 R /Dest [5 0 R /XYZ 0 400 0] >>\nendobj\n";

/**
 * 条目体带 `/Type /Page`：走进页树了。必须当场报错——页数与大头条数可能刚好相等，
 * 拿 `/Count` 核对兜底是兜不住的。
 */
export const OUTLINE_PAGE_NODE =
  "10 0 obj\n<< /Type /Outlines /First 11 0 R /Last 11 0 R /Count 1 >>\nendobj\n" +
  "11 0 obj\n<< /Type /Page /Parent 10 0 R /Dest [3 0 R /XYZ 0 800 0] >>\nendobj\n";

/** 真 trailer 之后再挂一行**注释**形态的假 trailer：注释里的 `trailer`/`/Root` 不许被当真。 */
export const bytesWithTrailerCommentOf = (body: string): Uint8Array =>
  Buffer.from(`${body}${trailerOf()}% trailer << /Root 99 0 R >>\n`, "latin1");

/**
 * 真 trailer（已含 `startxref`/`%%EOF`）之后**再写一个非注释的 trailer**：它不是注释，会被扫成第二个
 * `PdfTrailer`，只能靠“位置在最后一个 `startxref` 之前”这道过滤挡掉；少了过滤就会去认 `/Root 99 0 R`。
 */
export const bytesWithTrailingTrailerOf = (body: string): Uint8Array =>
  Buffer.from(`${body}${trailerOf()}trailer\n<< /Size 99 /Root 99 0 R >>\n`, "latin1");

/**
 * 内容流里写着能误导解析器的字节：裸 `1 0 obj` 重生 Catalog（或指 `/Outlines 99 0 R`）、
 * `99 0 obj` 的大纲指向不存在的 98。`stream` 之后不跳到 `endstream`，扫描器就会把流内容当结构，
 * 报“找不到 大纲条目 对象 98”——所以这份夹具钉的是“跳过 stream”，不是“流里恰好有个 endobj 也无害”。
 */
export const OUTLINE_STREAM_TRAP =
  "900 0 obj\n<< /Length 156 >>\nstream\n" +
  "1 0 obj\n<< /Type /Catalog /Pages 2 0 R /Outlines 99 0 R >>\nendobj\n" +
  "99 0 obj\n<< /Type /Outlines /First 98 0 R /Last 98 0 R /Count 5 >>\nendobj\n" +
  "endstream\nendobj\n";

/** 对象号 1 的 generation 是 5（不是 0）：引用写成 `1 5 R`，定位只认对象号。 */
export const bytesWithGenerationOf = (body: string): Uint8Array =>
  Buffer.from(
    body.replace("1 0 obj", "1 5 obj") +
      "trailer\n<< /Size 99 /Root 1 5 R >>\nstartxref\n0000\n%%EOF\n",
    "latin1",
  );
