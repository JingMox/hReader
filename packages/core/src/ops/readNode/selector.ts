// 这层管：选择器的窄文法（逐字符扫描，只认 4 种形态）；不查树、不算字节。
// BNF：`wsp`=空格/制表，`name`=[A-Za-z][A-Za-z0-9-]*，`id`=[a-z0-9-]+，`n`=十进制且 ≥1。
// selector := "#" id | "[" "data-hr-id" "=" value "]" | name | name wsp* ">" wsp* name wsp* ":nth-of-type(" n ")"；标签名与属性名比较不分大小写

import { HrError } from "../../hr-error";
import type { Selector } from "./constants";

const NAME_START = /[A-Za-z]/;
const NAME_CHAR = /[A-Za-z0-9]/;
const ID_CHAR = /[a-z0-9-]/;
const DIGIT = /[0-9]/;
const SPACE = /[ \t\n\r]/;

interface Scan {
  readonly text: string;
  position: number;
}

const rest = (scan: Scan): string => scan.text.slice(scan.position);

const fail = (reason: string, scan: Scan): never => {
  throw new HrError("invalid_selector", `非法选择器（${reason}）：${JSON.stringify(scan.text)}`);
};

const skipSpaces = (scan: Scan): void => {
  for (;;) {
    const character = scan.text[scan.position];
    if (character === undefined || !SPACE.test(character)) {
      return;
    }
    scan.position += 1;
  }
};

/** 连续字符类扫描；一个字符都没吃到就立即判非法（不留“空跑”分支）。 */
const readRun = (scan: Scan, accepted: RegExp, label: string): string => {
  const start = scan.position;
  for (;;) {
    const character = scan.text[scan.position];
    if (character === undefined || !accepted.test(character)) {
      break;
    }
    scan.position += 1;
  }
  if (scan.position === start) {
    fail(`此处应为${label}`, scan);
  }
  return scan.text.slice(start, scan.position);
};

const readName = (scan: Scan): string => {
  const head = scan.text[scan.position] ?? "";
  if (!NAME_START.test(head)) {
    fail("标签名应以 ASCII 字母开头", scan);
  }
  scan.position += 1;
  return `${head}${readRunOrEmpty(scan, NAME_CHAR)}`;
};

const readRunOrEmpty = (scan: Scan, accepted: RegExp): string => {
  const start = scan.position;
  for (;;) {
    const character = scan.text[scan.position];
    if (character === undefined || !accepted.test(character)) {
      return scan.text.slice(start, scan.position);
    }
    scan.position += 1;
  }
};

const expectEnd = (scan: Scan, reason: string): void => {
  skipSpaces(scan);
  if (scan.position !== scan.text.length) {
    fail(reason, scan);
  }
};

const readValue = (scan: Scan): string => {
  const quote = scan.text[scan.position];
  if (quote !== '"' && quote !== "'") {
    return readRun(scan, /[^\s\]=]/, "属性值");
  }
  const end = scan.text.indexOf(quote, scan.position + 1);
  if (end < 0) {
    fail("属性值引号未闭合", scan);
  }
  const value = scan.text.slice(scan.position + 1, end);
  scan.position = end + 1;
  return value;
};

const parseIdForm = (scan: Scan): Selector => {
  scan.position += 1;
  const id = readRun(scan, ID_CHAR, " data-hr-id");
  expectEnd(scan, "id 之后不应再有字符");
  return { kind: "id", id };
};

const ATTRIBUTE_NAME = "data-hr-id";

const parseAttributeForm = (scan: Scan): Selector => {
  scan.position += 1;
  skipSpaces(scan);
  if (!rest(scan).toLowerCase().startsWith(ATTRIBUTE_NAME)) {
    fail("只支持 [data-hr-id=...]", scan);
  }
  scan.position += ATTRIBUTE_NAME.length;
  skipSpaces(scan);
  if (scan.text[scan.position] !== "=") {
    fail("缺少 =", scan);
  }
  scan.position += 1;
  skipSpaces(scan);
  const value = readValue(scan);
  skipSpaces(scan);
  if (scan.text[scan.position] !== "]") {
    fail("缺少 ]", scan);
  }
  scan.position += 1;
  expectEnd(scan, "] 之后不应再有字符");
  return { kind: "id", id: value };
};

const PSEUDO = ":nth-of-type(";

const parseChildForm = (scan: Scan, parent: string): Selector => {
  scan.position += 1;
  skipSpaces(scan);
  const tag = readName(scan).toLowerCase();
  skipSpaces(scan);
  if (!rest(scan).toLowerCase().startsWith(PSEUDO)) {
    fail("只支持 :nth-of-type(n)", scan);
  }
  scan.position += PSEUDO.length;
  const digits = readRun(scan, DIGIT, "序号");
  if (scan.text[scan.position] !== ")") {
    fail("缺少 )", scan);
  }
  scan.position += 1;
  expectEnd(scan, ") 之后不应再有字符");
  const index = Number.parseInt(digits, 10);
  if (index < 1) {
    fail("序号必须 ≥1", scan);
  }
  return { kind: "child", parent, tag, index };
};

/** 4 种形态之外一律 `invalid_selector`：不许降级、不许“尽力而为”。 */
export const parseSelector = (text: string): Selector => {
  const scan: Scan = { text: text.trim(), position: 0 };
  if (scan.text.length === 0) {
    fail("空串", scan);
  }
  const head = scan.text[0];
  if (head === "#") {
    return parseIdForm(scan);
  }
  if (head === "[") {
    return parseAttributeForm(scan);
  }
  const name = readName(scan).toLowerCase();
  skipSpaces(scan);
  if (scan.position === scan.text.length) {
    return { kind: "tag", tag: name };
  }
  if (scan.text[scan.position] === ">") {
    return parseChildForm(scan, name);
  }
  return fail('只支持 #id / [data-hr-id="x"] / tag / tag > tag:nth-of-type(n)', scan);
};
