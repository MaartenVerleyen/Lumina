use crate::*;

// ----------------- PERFORMANCE TIMING (surfaces in the Session Log under PERF) -----------------

#[derive(Serialize, Clone)]
pub struct PerfLogEvent {
    pub label: String,
    pub millis: u64,
    pub count: usize,
    pub details: String,
}

pub fn elapsed_ms(start: Instant) -> u64 {
    start.elapsed().as_millis() as u64
}

pub fn per_second(count: usize, millis: u64) -> f64 {
    if millis == 0 {
        return 0.0;
    }
    ((count as f64 * 1000.0 / millis as f64) * 10.0).round() / 10.0
}

pub fn emit_perf(app: &AppHandle, label: &str, started: Instant, count: usize, details: String) {
    let millis = elapsed_ms(started);
    eprintln!("[perf] {label}: {millis} ms, {count} items ({details})");
    let _ = app.emit(
        "perf-log",
        PerfLogEvent {
            label: label.to_string(),
            millis,
            count,
            details,
        },
    );
}
