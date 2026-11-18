//! bootstrap URL 拼装：docId 走 path-segment、token 走 query，两者都按 RFC3986 转义。

const UNRESERVED: &[u8] = b"-._~";

fn is_unreserved(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || UNRESERVED.contains(&byte)
}

fn push_encoded(out: &mut String, text: &str, keep: fn(u8) -> bool) {
    for &byte in text.as_bytes() {
        if is_unreserved(byte) || keep(byte) {
            out.push(char::from(byte));
        } else {
            out.push('%');
            out.push_str(&format!("{byte:02X}"));
        }
    }
}

/// `docId` 是 workspace 相对路径：`/` 保留成路径分隔符，其余非未保留字符一律转义。
/// `#` 尤其不能漏——它是 fragment 分隔符，漏了就轮到 `?t=` 被截断成 fragment。
///
/// `.`/`..`/空段一律拒绝：daemon 侧的 `isInside`+`realpath`（`packages/core/src/io/paths.ts:76/79`）
/// 已经挡住了越界，但 URL 层不该把这种路径编码出去。错误是返回值，不是 panic。
pub fn encode_path(doc_id: &str) -> Result<String, PathError> {
    for segment in doc_id.split('/') {
        if segment.is_empty() {
            return Err(PathError::EmptySegment);
        }
        if segment == "." || segment == ".." {
            return Err(PathError::DotSegment);
        }
    }
    let mut out = String::new();
    push_encoded(&mut out, doc_id, |byte| byte == b'/');
    Ok(out)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PathError {
    EmptySegment,
    DotSegment,
}

impl std::fmt::Display for PathError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::EmptySegment => write!(formatter, "文档路径里有空路径段"),
            Self::DotSegment => write!(formatter, "文档路径里不允许 `.` / `..` 路径段"),
        }
    }
}

pub fn encode_query(value: &str) -> String {
    let mut out = String::new();
    push_encoded(&mut out, value, |_| false);
    out
}

/// 壳**唯一**的认证入口：webview 自己加载这个 URL，服务端 302 到同路径并 `Set-Cookie`，
/// cookie 才进得了 webview 的 jar（Rust 侧代拿 cookie 没用）。所以绝不许改成 `/?t=`。
pub fn bootstrap_url(port: u16, doc_id: &str, token: &str) -> Result<String, PathError> {
    Ok(format!(
        "http://127.0.0.1:{port}/s/{}?t={}",
        encode_path(doc_id)?,
        encode_query(token)
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 最小 RFC3986 解码器：只为断言"往返相等"，不参与生产路径。
    fn decode(text: &str) -> String {
        let bytes = text.as_bytes();
        let mut out: Vec<u8> = Vec::new();
        let mut index = 0;
        while index < bytes.len() {
            if bytes[index] == b'%' {
                let hex = std::str::from_utf8(&bytes[index + 1..index + 3]).expect("两位十六进制");
                out.push(u8::from_str_radix(hex, 16).expect("十六进制"));
                index += 3;
            } else {
                out.push(bytes[index]);
                index += 1;
            }
        }
        String::from_utf8(out).expect("UTF-8")
    }

    const DOC_IDS: [&str; 4] = ["a/b.html", "空格 x.html", "a#b", "a?b"];
    const TOKENS: [&str; 3] = [
        "abcdefghijklmnopqrstuvwxyz0123456789ABCDEF-AB",
        "a&b=c",
        "a+b",
    ];

    #[test]
    fn ac2_slash_survives_and_reserved_bytes_are_escaped() {
        assert_eq!(encode_path("a/b.html"), Ok("a/b.html".to_string()));
        assert_eq!(encode_path("a#b"), Ok("a%23b".to_string()));
        assert_eq!(encode_path("a?b"), Ok("a%3Fb".to_string()));
        assert_eq!(encode_path("100%"), Ok("100%25".to_string()));
        assert_eq!(encode_query("a&b=c"), "a%26b%3Dc");
        assert_eq!(encode_query("a+b"), "a%2Bb");
    }

    #[test]
    fn ac2_dot_segments_are_rejected_at_the_url_layer() {
        assert_eq!(encode_path("../x.html"), Err(PathError::DotSegment));
        assert_eq!(encode_path("a/../x.html"), Err(PathError::DotSegment));
        assert_eq!(encode_path("./x.html"), Err(PathError::DotSegment));
        assert_eq!(encode_path("a/./x.html"), Err(PathError::DotSegment));
        assert_eq!(encode_path("a//b.html"), Err(PathError::EmptySegment));
        assert_eq!(encode_path(""), Err(PathError::EmptySegment));
        // 文件名里含点（`a..b.html`）是合法的，切段后不等于 `..`。
        assert_eq!(encode_path("a..b.html"), Ok("a..b.html".to_string()));
        assert_eq!(
            bootstrap_url(8123, "../x.html", "tok"),
            Err(PathError::DotSegment)
        );
    }

    #[test]
    fn ac2_round_trip_for_every_doc_id_and_token() {
        for doc_id in DOC_IDS {
            for token in TOKENS {
                let url = bootstrap_url(8123, doc_id, token).expect("文档路径合法");
                let (path, query) = url.split_once("?t=").expect("bootstrap URL 必须带 ?t=");
                assert_eq!(
                    path,
                    format!(
                        "http://127.0.0.1:8123/s/{}",
                        encode_path(doc_id).expect("合法")
                    )
                );
                assert!(path.starts_with("http://127.0.0.1:8123/s/"));
                assert_eq!(decode(&path["http://127.0.0.1:8123/s/".len()..]), doc_id);
                assert_eq!(decode(query), token);
                assert!(!query.is_empty());
            }
        }
    }

    #[test]
    fn ac2_hash_in_doc_id_cannot_swallow_the_token() {
        let url = bootstrap_url(9000, "a#b.html", "tok").expect("a#b.html 在段内不算非法");
        assert!(!url.contains('#'));
        assert!(url.ends_with("?t=tok"));
    }
}
