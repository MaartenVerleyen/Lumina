// Failed logins hold back the next try, per name and per client address: each key keeps the time its next
// attempt is allowed. An attempt that comes earlier is refused without checking the password (429 with
// Retry-After). An attempt that is let through takes the slot at once, as if it will fail, so attempts
// sent in parallel can't all be checked while the first one's password is still being hashed. Every
// failure doubles the wait (0.5 s, 1 s, 2 s, ... at most 30 s), a successful login clears it, and keys are
// forgotten after 15 minutes without new failures. The same holds whether or not the name exists.
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

const FORGET_AFTER: Duration = Duration::from_secs(15 * 60);
const FIRST_DELAY: Duration = Duration::from_millis(500);
const MAX_DELAY: Duration = Duration::from_secs(30);

struct Key {
    failures: u32,
    next_allowed: Instant,
    last_seen: Instant,
}

#[derive(Default)]
pub struct LoginThrottle {
    keys: Mutex<HashMap<String, Key>>,
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
    // Lets an attempt through (and holds the next one back until it is decided), or says how long to wait
    pub fn begin(&self, name: &str, addr: &str) -> Result<(), Duration> {
        let mut map = self.keys.lock().unwrap();
        let now = Instant::now();
        map.retain(|_, k| now.duration_since(k.last_seen) < FORGET_AFTER);
        let keys = keys(name, addr);
        let wait = keys
            .iter()
            .filter_map(|k| map.get(k))
            .map(|k| k.next_allowed.saturating_duration_since(now))
            .max()
            .unwrap_or(Duration::ZERO);
        if !wait.is_zero() {
            return Err(wait);
        }
        for key in keys {
            let entry = map.entry(key).or_insert(Key { failures: 0, next_allowed: now, last_seen: now });
            entry.next_allowed = now + delay_for(entry.failures + 1);
            entry.last_seen = now;
        }
        Ok(())
    }

    pub fn failed(&self, name: &str, addr: &str) {
        let mut map = self.keys.lock().unwrap();
        let now = Instant::now();
        for key in keys(name, addr) {
            let entry = map.entry(key).or_insert(Key { failures: 0, next_allowed: now, last_seen: now });
            entry.failures = entry.failures.saturating_add(1);
            entry.next_allowed = now + delay_for(entry.failures);
            entry.last_seen = now;
        }
    }

    pub fn succeeded(&self, name: &str, addr: &str) {
        let mut map = self.keys.lock().unwrap();
        for key in keys(name, addr) {
            map.remove(&key);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn waits(t: &LoginThrottle, name: &str, addr: &str) -> Duration {
        t.begin(name, addr).err().unwrap_or(Duration::ZERO)
    }

    #[test]
    fn an_attempt_holds_back_the_next_until_it_is_decided() {
        let t = LoginThrottle::default();
        assert!(t.begin("anna", "1.2.3.4").is_ok());
        assert!(t.begin("anna", "9.9.9.9").is_err(), "the same name while the first is being checked");
        assert!(t.begin("bob", "1.2.3.4").is_err(), "the same address while the first is being checked");
        assert!(t.begin("bob", "5.6.7.8").is_ok());
        t.succeeded("anna", "1.2.3.4");
        assert!(t.begin("anna", "1.2.3.4").is_ok(), "a success clears the wait");
    }

    #[test]
    fn each_failure_doubles_the_wait_up_to_a_limit() {
        let t = LoginThrottle::default();
        t.failed("anna", "1.2.3.4");
        let w = waits(&t, "anna", "1.2.3.4");
        assert!(w > Duration::from_millis(400) && w <= Duration::from_millis(500), "{w:?}");
        t.failed("anna", "1.2.3.4");
        let w = waits(&t, "Anna", "5.6.7.8");
        assert!(w > Duration::from_millis(900) && w <= Duration::from_secs(1), "per name, whatever the address: {w:?}");
        assert!(waits(&t, "bob", "1.2.3.4") > Duration::from_millis(900), "per address, whatever the name");
        assert!(t.begin("bob", "5.6.7.8").is_ok());
        for _ in 0..20 {
            t.failed("anna", "1.2.3.4");
        }
        assert!(waits(&t, "anna", "1.2.3.4") > MAX_DELAY - Duration::from_secs(1));
        t.succeeded("anna", "1.2.3.4");
        assert!(t.begin("anna", "1.2.3.4").is_ok());
    }
}
