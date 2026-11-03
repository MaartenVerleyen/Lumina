// Failed logins slow down the next try, per name and per client address: every failure doubles the wait
// (0.5 s, 1 s, 2 s, ... at most 30 s), a successful login clears it, and failures are forgotten after 15
// minutes without new ones. The wait applies to the next attempt whether or not the name exists.
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

const FORGET_AFTER: Duration = Duration::from_secs(15 * 60);
const FIRST_DELAY: Duration = Duration::from_millis(500);
const MAX_DELAY: Duration = Duration::from_secs(30);

#[derive(Default)]
pub struct LoginThrottle {
    failures: Mutex<HashMap<String, (u32, Instant)>>,
}

fn keys(name: &str, addr: &str) -> [String; 2] {
    [format!("name:{}", name.trim().to_lowercase()), format!("addr:{addr}")]
}

fn delay_for(failures: u32) -> Duration {
    if failures == 0 {
        return Duration::ZERO;
    }
    FIRST_DELAY.saturating_mul(1 << (failures - 1).min(10)).min(MAX_DELAY)
}

impl LoginThrottle {
    // How long to wait before checking this attempt
    pub fn delay(&self, name: &str, addr: &str) -> Duration {
        let mut map = self.failures.lock().unwrap();
        let now = Instant::now();
        map.retain(|_, (_, last)| now.duration_since(*last) < FORGET_AFTER);
        keys(name, addr).iter().map(|k| map.get(k).map_or(0, |(n, _)| *n)).max().map_or(Duration::ZERO, delay_for)
    }

    pub fn failed(&self, name: &str, addr: &str) {
        let mut map = self.failures.lock().unwrap();
        let now = Instant::now();
        for key in keys(name, addr) {
            let entry = map.entry(key).or_insert((0, now));
            entry.0 = entry.0.saturating_add(1);
            entry.1 = now;
        }
    }

    pub fn succeeded(&self, name: &str, addr: &str) {
        let mut map = self.failures.lock().unwrap();
        for key in keys(name, addr) {
            map.remove(&key);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn each_failure_doubles_the_wait_up_to_a_limit() {
        let t = LoginThrottle::default();
        assert_eq!(t.delay("anna", "1.2.3.4"), Duration::ZERO);
        t.failed("anna", "1.2.3.4");
        assert_eq!(t.delay("anna", "1.2.3.4"), Duration::from_millis(500));
        t.failed("anna", "1.2.3.4");
        assert_eq!(t.delay("Anna", "5.6.7.8"), Duration::from_secs(1), "per name, whatever the address");
        assert_eq!(t.delay("bob", "1.2.3.4"), Duration::from_secs(1), "per address, whatever the name");
        assert_eq!(t.delay("bob", "5.6.7.8"), Duration::ZERO);
        for _ in 0..20 {
            t.failed("anna", "1.2.3.4");
        }
        assert_eq!(t.delay("anna", "1.2.3.4"), MAX_DELAY);
        t.succeeded("anna", "1.2.3.4");
        assert_eq!(t.delay("anna", "1.2.3.4"), Duration::ZERO);
    }
}
