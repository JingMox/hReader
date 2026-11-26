//! 子进程归属记账：只有本进程 `own` 过的 pid 才允许 kill。
//!
//! `daemon.json` 里的 pid 可能是**用户自己**起的 daemon（壳重启后复用），那不是壳的孩子。
//! 没有这份账就会在退出时误杀用户进程——这是最关键的一条。

#[derive(Debug, Default)]
pub struct ChildRegistry {
    own: Vec<u32>,
    external: Vec<u32>,
}

impl ChildRegistry {
    pub fn own(&mut self, pid: u32) {
        if !self.own.contains(&pid) {
            self.own.push(pid);
        }
    }

    /// 记账但不接管：从 `daemon.json` 读到的 pid 走这里，永远不进 kill 名单（先到先得，不降级）。
    pub fn adopt_external(&mut self, pid: u32) {
        if !self.own.contains(&pid) && !self.external.contains(&pid) {
            self.external.push(pid);
        }
    }

    pub fn should_kill(&self, pid: u32) -> bool {
        self.own.contains(&pid)
    }

    pub fn owned(&self) -> &[u32] {
        &self.own
    }

    pub fn external(&self) -> &[u32] {
        &self.external
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn spawned_child_is_killable() {
        let mut registry = ChildRegistry::default();
        registry.own(1);
        assert!(registry.should_kill(1));
    }

    #[test]
    fn adopted_external_is_never_killable() {
        let mut registry = ChildRegistry::default();
        registry.adopt_external(2);
        assert!(!registry.should_kill(2));
        assert_eq!(registry.external(), [2]);
        assert!(registry.owned().is_empty());
    }

    #[test]
    fn repeated_own_is_idempotent() {
        let mut registry = ChildRegistry::default();
        registry.own(1);
        registry.own(1);
        assert_eq!(registry.owned(), [1]);
    }

    #[test]
    fn own_then_adopt_does_not_downgrade() {
        let mut registry = ChildRegistry::default();
        registry.own(1);
        registry.adopt_external(1);
        assert!(registry.should_kill(1));
        assert!(registry.external().is_empty());
    }

    #[test]
    fn unknown_pid_is_not_killable() {
        let registry = ChildRegistry::default();
        assert!(!registry.should_kill(9));
    }
}
