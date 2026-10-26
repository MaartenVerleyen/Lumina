// ----------------- FACE EVALUATION BENCHMARK (manual, #[ignore]) -----------------
// Measures detection and person matching on a labelled folder, using exactly the app's pipeline
// (open_and_orient_image -> FaceModels::analyze -> face_match::profile_score / assign_face / cluster_faces).
//
// Folder layout:  <set>\<Person>\*.jpg   one person per folder; their largest face in each photo is them
//                 <set>\_strangers\*      people who are not in the set (any suggestion is wrong)
//                 <set>\_groups\N_*.jpg   group photos, N = number of visible faces (detection check)
//
// PowerShell: $env:LUMINA_FACE_EVAL="D:\FaceEval"; $env:LUMINA_DIAG_OUT="<folder for the JSON report>"
//             cargo test --release --lib face_eval -- --ignored --nocapture
// Optional:   $env:LUMINA_MODELS (folder with det_10g.onnx and w600k_r50.onnx; default
//             %LOCALAPPDATA%\com.amazhr.lumina\models), $env:LUMINA_EVAL_LABEL

use crate::*;

const EXTS: [&str; 10] = ["jpg", "jpeg", "png", "heic", "heif", "cr2", "cr3", "nef", "arw", "dng"];
const THRESHOLDS: [f32; 9] = [0.40, 0.45, 0.50, 0.55, 0.60, 0.65, 0.70, 0.75, 0.80];

struct Probe {
    person: usize,
    file: String,
    embedding: Vec<f32>,
}

fn image_files(dir: &Path) -> Vec<PathBuf> {
    let mut files: Vec<PathBuf> = fs::read_dir(dir)
        .map(|rd| rd.flatten().map(|e| e.path()).collect())
        .unwrap_or_default();
    files.retain(|p| {
        p.is_file()
            && p.extension()
                .map(|e| EXTS.contains(&e.to_string_lossy().to_lowercase().as_str()))
                .unwrap_or(false)
    });
    files.sort();
    files
}

// The app's face engine (engine v2: SCRFD + aligned ArcFace r50). The old UltraFace + MobileFaceNet engine was
// removed after its baseline was recorded (53/100 faces found, rank-1 32%, 0% recall at its 0.60 threshold).
enum Engine {
    V2(FaceModels),
}

struct EvalFace {
    bbox: (f64, f64, f64, f64),
    embedding: Vec<f32>,
}

fn faces_in(engine: &Engine, path: &Path) -> Option<Vec<EvalFace>> {
    let img = open_and_orient_image(path).ok()?;
    Some(match engine {
        Engine::V2(models) => models
            .analyze(&img)
            .ok()?
            .into_iter()
            .map(|f| EvalFace { bbox: f.detection.bbox, embedding: f.embedding })
            .collect(),
    })
}

fn largest(faces: Vec<EvalFace>) -> Option<EvalFace> {
    faces.into_iter().max_by(|a, b| {
        (a.bbox.2 * a.bbox.3)
            .partial_cmp(&(b.bbox.2 * b.bbox.3))
            .unwrap_or(std::cmp::Ordering::Equal)
    })
}

// The app's scoring (face_match::profile_score with the production SCORE_METHOD)
fn person_score(cand: &[f32], refs: &[Vec<f32>]) -> f32 {
    build_profile(refs.to_vec(), Vec::new())
        .map(|profile| profile_score(cand, &profile, SCORE_METHOD))
        .unwrap_or(0.0)
}

#[derive(Serialize)]
struct ThresholdRow {
    threshold: f32,
    recall: f64,
    wrong_suggestions_per_photo: f64,
    precision: f64,
    stranger_false_alarm_rate: f64,
}

#[derive(Serialize)]
struct RefScenario {
    references: String,
    rank1_accuracy: f64,
    rows: Vec<ThresholdRow>,
}

#[derive(Serialize)]
struct EvalReport {
    label: String,
    people: usize,
    person_photos: usize,
    person_photos_with_face: usize,
    strangers: usize,
    strangers_with_face: usize,
    group_faces_expected: usize,
    group_faces_detected: usize,
    scenarios: Vec<RefScenario>,
    seconds: f64,
}

#[test]
#[ignore]
fn face_eval() {
    let Ok(set) = std::env::var("LUMINA_FACE_EVAL") else {
        eprintln!("Set LUMINA_FACE_EVAL to the labelled face folder");
        return;
    };
    let models = std::env::var("LUMINA_MODELS").map(PathBuf::from).unwrap_or_else(|_| {
        PathBuf::from(std::env::var("LOCALAPPDATA").unwrap_or_default()).join("com.amazhr.lumina").join("models")
    });
    let label = std::env::var("LUMINA_EVAL_LABEL").unwrap_or_else(|_| "engine v2".to_string());
    let started = Instant::now();

    let loaded = FaceModels::load(&models).expect("face models not found (det_10g.onnx, w600k_r50.onnx)");
    eprintln!("face engine on {}", loaded.device);
    let engine = Engine::V2(loaded);
    let detector = &engine;

    let set = PathBuf::from(set);
    let mut people: Vec<(String, Vec<PathBuf>)> = fs::read_dir(&set)
        .unwrap()
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.is_dir() && !p.file_name().unwrap().to_string_lossy().starts_with('_'))
        .map(|p| (p.file_name().unwrap().to_string_lossy().to_string(), image_files(&p)))
        .collect();
    people.sort();

    // Person photos: the largest face is the labelled person
    let jobs: Vec<(usize, PathBuf)> = people
        .iter()
        .enumerate()
        .flat_map(|(i, (_, files))| files.iter().map(move |f| (i, f.clone())))
        .collect();
    let mut probes: Vec<Probe> = Vec::new();
    let mut misses: Vec<String> = Vec::new();
    let results: Vec<(usize, PathBuf, Option<EvalFace>)> = jobs
        .par_iter()
        .map(|(i, f)| (*i, f.clone(), faces_in(detector, f).and_then(largest)))
        .collect();
    for (person, file, face) in results {
        let name = format!("{}\\{}", people[person].0, file.file_name().unwrap().to_string_lossy());
        match face {
            Some(face) => probes.push(Probe { person, file: name, embedding: face.embedding }),
            None => misses.push(name),
        }
    }

    // Strangers: any face of theirs that gets suggested as one of the people is a false alarm
    let stranger_files = image_files(&set.join("_strangers"));
    let strangers: Vec<Vec<f32>> = stranger_files
        .par_iter()
        .filter_map(|f| faces_in(detector, f).and_then(largest).map(|face| face.embedding))
        .collect();

    // Groups: detected faces vs the count in the file name
    let group_counts: Vec<(String, usize, usize)> = image_files(&set.join("_groups"))
        .par_iter()
        .map(|f| {
            let name = f.file_name().unwrap().to_string_lossy().to_string();
            let expected = name.split('_').next().and_then(|n| n.parse().ok()).unwrap_or(0);
            let found = faces_in(detector, f).map(|v| v.len()).unwrap_or(0);
            (name, expected, found)
        })
        .collect();

    eprintln!("\n=== Face eval: {label} ===");
    eprintln!(
        "Detection: {}/{} person photos had a usable face; {}/{} strangers",
        probes.len(),
        jobs.len(),
        strangers.len(),
        stranger_files.len()
    );
    for m in &misses {
        eprintln!("  no face: {m}");
    }
    let (mut exp_total, mut found_total) = (0, 0);
    for (name, expected, found) in &group_counts {
        eprintln!("  group {name}: {found} of {expected} faces");
        exp_total += expected;
        found_total += (*found).min(*expected);
    }
    if exp_total > 0 {
        eprintln!("  groups total: {found_total} of {exp_total} faces found");
    }

    let mut scenarios = Vec::new();
    for (scenario, max_refs) in [("all other photos of the person (up to 9)", usize::MAX), ("3 confirmed faces", 3)] {
        // References for (person, excluding probe index): the person's other probes, in file order
        let refs_for = |person: usize, exclude: Option<usize>| -> Vec<Vec<f32>> {
            probes
                .iter()
                .enumerate()
                .filter(|(i, p)| p.person == person && Some(*i) != exclude)
                .take(max_refs)
                .map(|(_, p)| p.embedding.clone())
                .collect()
        };
        // scores[probe][person]
        let scores: Vec<Vec<f32>> = probes
            .iter()
            .enumerate()
            .map(|(pi, probe)| {
                (0..people.len())
                    .map(|person| {
                        let exclude = (person == probe.person).then_some(pi);
                        person_score(&probe.embedding, &refs_for(person, exclude))
                    })
                    .collect()
            })
            .collect();
        let stranger_scores: Vec<Vec<f32>> = strangers
            .iter()
            .map(|s| (0..people.len()).map(|person| person_score(s, &refs_for(person, None))).collect())
            .collect();

        let rank1 = probes
            .iter()
            .zip(&scores)
            .filter(|(probe, row)| {
                let best = row
                    .iter()
                    .enumerate()
                    .max_by(|a, b| a.1.partial_cmp(b.1).unwrap_or(std::cmp::Ordering::Equal))
                    .map(|(i, _)| i);
                best == Some(probe.person)
            })
            .count() as f64
            / probes.len().max(1) as f64;

        eprintln!("\nReferences: {scenario}   rank-1 accuracy {:.1}%", rank1 * 100.0);
        eprintln!("  threshold | found own person | wrong people suggested per photo | precision | strangers suggested");
        let mut rows = Vec::new();
        for &t in &THRESHOLDS {
            let correct = probes.iter().zip(&scores).filter(|(p, row)| row[p.person] >= t).count();
            let wrong: usize = probes
                .iter()
                .zip(&scores)
                .map(|(p, row)| row.iter().enumerate().filter(|(i, s)| *i != p.person && **s >= t).count())
                .sum();
            let stranger_alarms = stranger_scores.iter().filter(|row| row.iter().any(|s| *s >= t)).count();
            let row = ThresholdRow {
                threshold: t,
                recall: correct as f64 / probes.len().max(1) as f64,
                wrong_suggestions_per_photo: wrong as f64 / probes.len().max(1) as f64,
                precision: correct as f64 / (correct + wrong).max(1) as f64,
                stranger_false_alarm_rate: stranger_alarms as f64 / strangers.len().max(1) as f64,
            };
            eprintln!(
                "  {:.2}{}    | {:>5.1}%           | {:>5.2}                            | {:>5.1}%    | {:>5.1}%",
                t,
                if (t - FACE_MATCH_MIN_SIMILARITY).abs() < 1e-6 { "*" } else { " " },
                row.recall * 100.0,
                row.wrong_suggestions_per_photo,
                row.precision * 100.0,
                row.stranger_false_alarm_rate * 100.0
            );
            rows.push(row);
        }

        // Which people get mixed up most at the app's current threshold
        let mut confusions: HashMap<(usize, usize), usize> = HashMap::new();
        for (p, row) in probes.iter().zip(&scores) {
            for (other, s) in row.iter().enumerate() {
                if other != p.person && *s >= FACE_MATCH_MIN_SIMILARITY {
                    *confusions.entry((p.person, other)).or_default() += 1;
                }
            }
        }
        let mut confusions: Vec<_> = confusions.into_iter().collect();
        confusions.sort_by(|a, b| b.1.cmp(&a.1));
        for ((a, b), n) in confusions.iter().take(5) {
            eprintln!("  confused at {FACE_MATCH_MIN_SIMILARITY:.2}: {} photo(s) of {} suggested as {}", n, people[*a].0, people[*b].0);
        }

        // Photos whose best match is someone else (names only, for spot-checking)
        for (p, row) in probes.iter().zip(&scores) {
            let (best, best_score) = row
                .iter()
                .enumerate()
                .max_by(|a, b| a.1.partial_cmp(b.1).unwrap_or(std::cmp::Ordering::Equal))
                .map(|(i, s)| (i, *s))
                .unwrap_or((p.person, 0.0));
            if best != p.person {
                eprintln!(
                    "  best match wrong: {} -> {} ({:.2}; own {:.2})",
                    p.file, people[best].0, best_score, row[p.person]
                );
            }
        }

        scenarios.push(RefScenario { references: scenario.to_string(), rank1_accuracy: rank1, rows });
    }

    evaluate_matching_v2(&people, &probes, &strangers);

    let report = EvalReport {
        label: label.clone(),
        people: people.len(),
        person_photos: jobs.len(),
        person_photos_with_face: probes.len(),
        strangers: stranger_files.len(),
        strangers_with_face: strangers.len(),
        group_faces_expected: exp_total,
        group_faces_detected: found_total,
        scenarios,
        seconds: started.elapsed().as_secs_f64(),
    };
    if let Ok(out) = std::env::var("LUMINA_DIAG_OUT") {
        let file = PathBuf::from(out).join(format!("face_eval_{}.json", label.replace(' ', "_")));
        let _ = fs::write(&file, serde_json::to_string_pretty(&report).unwrap());
        eprintln!("\nReport written to {}", file.display());
    }
}

// Manual: checks that ONNX Runtime + DirectML load the new face models, prints their inputs/outputs and timings.
// PowerShell: $env:LUMINA_NEW_MODELS="<folder with det_10g.onnx and w600k_r50.onnx>";
//             cargo test --release --lib ort_probe -- --ignored --nocapture
#[test]
#[ignore]
fn ort_probe() {
    use ort::session::Session;
    let dir = PathBuf::from(std::env::var("LUMINA_NEW_MODELS").expect("set LUMINA_NEW_MODELS"));
    let env = ort::init().with_name("lumina-probe").build().expect("ORT environment");
    eprintln!("DirectML available in this ONNX Runtime build: {}", ort::ep::directml::api().is_some());
    for (file, shape) in [("det_10g.onnx", [1usize, 3, 640, 640]), ("w600k_r50.onnx", [1usize, 3, 112, 112])] {
        for gpu in [true, false] {
            let mut builder = Session::builder(&env).unwrap();
            if gpu {
                builder = builder
                    .with_memory_pattern(false)
                    .unwrap()
                    .with_parallel_execution(false)
                    .unwrap()
                    .with_execution_providers([ort::ep::DirectML::default().build().error_on_failure()])
                    .unwrap();
            }
            let t = Instant::now();
            let mut session = match builder.commit_from_file(dir.join(file)) {
                Ok(s) => s,
                Err(e) => {
                    eprintln!("{file} gpu={gpu}: session failed: {e}");
                    continue;
                }
            };
            let load_ms = t.elapsed().as_millis();
            if !gpu {
                for i in session.inputs() {
                    eprintln!("  input  {} {:?}", i.name(), i.dtype());
                }
                for o in session.outputs() {
                    eprintln!("  output {} {:?}", o.name(), o.dtype());
                }
            }
            let input = ort::value::Tensor::from_array((shape, vec![0.1f32; shape.iter().product()])).unwrap();
            let mut runs = Vec::new();
            for _ in 0..6 {
                let t = Instant::now();
                let out = session.run(ort::inputs![input.view()]).unwrap();
                runs.push(t.elapsed().as_secs_f64() * 1000.0);
                drop(out);
            }
            eprintln!(
                "{file} gpu={gpu}: load {load_ms} ms, first run {:.1} ms, then {:.1} ms/run",
                runs[0],
                runs[1..].iter().sum::<f64>() / (runs.len() - 1) as f64
            );
        }
    }
}

// ----------------- PHASE 4b: SCORING, EXCLUSIVE ASSIGNMENT, CLUSTERING -----------------

fn profiles_for(people: &[(String, Vec<PathBuf>)], probes: &[Probe], exclude: usize, max_refs: usize) -> Vec<PersonProfile> {
    (0..people.len())
        .filter_map(|person| {
            let refs: Vec<Vec<f32>> = probes
                .iter()
                .enumerate()
                .filter(|(i, p)| p.person == person && *i != exclude)
                .take(max_refs)
                .map(|(_, p)| p.embedding.clone())
                .collect();
            build_profile(refs, Vec::new())
        })
        .collect()
}

fn evaluate_matching_v2(people: &[(String, Vec<PathBuf>)], probes: &[Probe], strangers: &[Vec<f32>]) {
    let n = probes.len().max(1) as f64;
    for (refs_label, max_refs) in [("9 refs", usize::MAX), ("3 refs", 3)] {
        eprintln!("\n--- {refs_label}: scoring method (suggest to every person above the threshold) ---");
        eprintln!("  method            | T=0.45 found/wrong | T=0.50 found/wrong | T=0.55 found/wrong | T=0.60 found/wrong");
        for method in [ScoreMethod::BestPlusCentroid, ScoreMethod::Top3PlusCentroid] {
            let mut line = format!("  {:<17} |", format!("{method:?}"));
            for t in [0.45f32, 0.50, 0.55, 0.60] {
                let (mut found, mut wrong) = (0usize, 0usize);
                for (pi, p) in probes.iter().enumerate() {
                    for (k, prof) in profiles_for(people, probes, pi, max_refs).iter().enumerate() {
                        let s = profile_score(&p.embedding, prof, method);
                        if s >= t {
                            // profiles_for skips nobody here (every person has photos), so index == person
                            if k == p.person { found += 1 } else { wrong += 1 }
                        }
                    }
                }
                line += &format!(" {:>5.1}% / {:<5.2}     |", found as f64 / n * 100.0, wrong as f64 / n);
            }
            eprintln!("{line}");
        }

        eprintln!("--- {refs_label}: exclusive assignment ({:?}, T=0.50) ---", SCORE_METHOD);
        eprintln!("  margin | found own person | wrong person | strangers suggested");
        for margin in [0.0f32, 0.03, 0.05, 0.08] {
            let (mut found, mut wrong) = (0usize, 0usize);
            for (pi, p) in probes.iter().enumerate() {
                let profiles = profiles_for(people, probes, pi, max_refs);
                if let Some(a) = assign_face(&p.embedding, &profiles, SCORE_METHOD, 0.50, margin) {
                    if a.person == p.person { found += 1 } else { wrong += 1 }
                }
            }
            let all = profiles_for(people, probes, usize::MAX, max_refs);
            let alarms = strangers
                .iter()
                .filter(|s| assign_face(s, &all, SCORE_METHOD, 0.50, margin).is_some())
                .count();
            eprintln!(
                "  {margin:.2}   | {:>5.1}%           | {:>5.1}%       | {:>5.1}%",
                found as f64 / n * 100.0,
                wrong as f64 / n * 100.0,
                alarms as f64 / strangers.len().max(1) as f64 * 100.0
            );
        }
    }

    // Clustering all person faces + strangers as if nobody were named yet
    eprintln!("\n--- clustering unknown faces (Chinese Whispers) ---");
    eprintln!("  threshold | clusters | pure clusters | people split into >1 cluster | biggest cluster per person (avg) | strangers merged into a person's cluster");
    let mut embs: Vec<Vec<f32>> = probes.iter().map(|p| p.embedding.clone()).collect();
    let mut truth: Vec<Option<usize>> = probes.iter().map(|p| Some(p.person)).collect();
    embs.extend(strangers.iter().cloned());
    truth.extend(strangers.iter().map(|_| None));
    for t in [0.35f32, 0.40, 0.45, 0.50, 0.55] {
        let labels = cluster_faces(&embs, t, 20);
        let mut members: HashMap<usize, Vec<usize>> = HashMap::new();
        for (i, l) in labels.iter().enumerate() {
            members.entry(*l).or_default().push(i);
        }
        let multi: Vec<&Vec<usize>> = members.values().filter(|m| m.len() >= 2).collect();
        let pure = multi
            .iter()
            .filter(|m| {
                let first = truth[m[0]];
                first.is_some() && m.iter().all(|&i| truth[i] == first)
            })
            .count();
        let mut split = 0;
        let mut biggest_share = 0f64;
        for person in 0..people.len() {
            let mine: Vec<usize> = (0..embs.len()).filter(|&i| truth[i] == Some(person)).collect();
            let mut per_label: HashMap<usize, usize> = HashMap::new();
            for &i in &mine {
                *per_label.entry(labels[i]).or_default() += 1;
            }
            if per_label.len() > 1 {
                split += 1;
            }
            biggest_share += *per_label.values().max().unwrap_or(&0) as f64 / mine.len().max(1) as f64;
        }
        let strangers_merged = (0..embs.len())
            .filter(|&i| truth[i].is_none())
            .filter(|&i| members[&labels[i]].iter().any(|&j| truth[j].is_some()))
            .count();
        eprintln!(
            "  {t:.2}      | {:>8} | {:>3} of {:<3}     | {:>2} of {:<2}                      | {:>5.1}%                           | {}",
            members.len(),
            pure,
            multi.len(),
            split,
            people.len(),
            biggest_share / people.len().max(1) as f64 * 100.0,
            strangers_merged
        );
    }
}
