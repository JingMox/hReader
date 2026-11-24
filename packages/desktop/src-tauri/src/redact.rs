//! 日志脱敏：所有要离开进程的文本（stdout/stderr/日志）都必须过 `redact`。
//!
//! token 的形状是不含 `+`/`/`/`=` 的 base64url 游程（`packages/core/src/server/server.ts` 里生成），
//! 所以"输出里还有一条 ≥N 字符的 base64url 游程"就是脱敏漏了——`has_base64url_span` 是这条判据。

/// token 为空时原样返回：空串替换会把整串文本打成 `***`，那是误伤而不是脱敏。
pub fn redact(text: &str, token: &str) -> String {
    if token.is_empty() {
        return text.to_string();
    }
    text.replace(token, "***")
}

pub fn has_base64url_span(text: &str, min_len: usize) -> bool {
    let mut run = 0_usize;
    for byte in text.bytes() {
        if byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_' {
            run += 1;
            if run >= min_len {
                return true;
            }
        } else {
            run = 0;
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 真实 token 形状：48 字符 base64url。
    const TOKEN: &str = "Qm9vR2xtU3R4dHl6MTIzNDU2Nzg5MEFCQ0RFRkdISUpLTE0N";

    #[test]
    fn all_six_shapes_are_redacted() {
        let shapes = [
            format!("http://127.0.0.1:8123/s/a.html?t={TOKEN}"),
            format!("http://127.0.0.1:8123/?doc=a.html#t={TOKEN}"),
            format!("http://127.0.0.1:8123/?doc=a.html&t={TOKEN}&x=1"),
            format!("{{\"token\":\"{TOKEN}\"}}"),
            format!("Url {{ scheme: \"http\", query: Some(\"t={TOKEN}\") }}"),
            format!("plain {TOKEN} plain"),
        ];
        for shape in shapes {
            let out = redact(&shape, TOKEN);
            assert!(!out.contains(TOKEN), "未脱敏：{out}");
            assert!(out.contains("***"), "应留下脱敏标记：{out}");
        }
    }

    #[test]
    fn text_without_token_is_returned_verbatim() {
        let text = "daemon 就绪 http://127.0.0.1:8123/";
        assert_eq!(redact(text, TOKEN), text);
    }

    #[test]
    fn empty_token_does_not_maul_the_text() {
        assert_eq!(redact("hello", ""), "hello");
    }

    #[test]
    fn base64url_span_detector() {
        assert!(has_base64url_span(TOKEN, 48));
        assert!(has_base64url_span(&format!("t={TOKEN}"), 48));
        assert!(!has_base64url_span("t=***", 48));
        assert!(!has_base64url_span("/tmp/hr-home-1234/.hreader", 48));
        assert!(has_base64url_span("abcdefghijklmnop", 16));
    }

    #[test]
    fn redacted_token_leaves_no_long_span() {
        let line = format!("nav {}", bootstrap_like());
        assert!(!has_base64url_span(&redact(&line, TOKEN), 48));
    }

    fn bootstrap_like() -> String {
        format!("/s/a.html?t={TOKEN}")
    }
}
