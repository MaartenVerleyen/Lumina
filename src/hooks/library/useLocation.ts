import { useState, useEffect, useRef } from "react";
import { call } from "../../api";
import { CitySearchResult } from "../../types/lumina";
import { expandWithRawPairs } from "../../utils/rawPairs";
import { expandWithLivePairs } from "../../utils/media";
import { LocationValue } from "./shared";
import type { LibraryCore } from "./core";

// Places: city search, setting a location by name or on the map (with undo)
export function useLocation(core: LibraryCore) {
  const {
    photos,
    setPhotos,
    photoByHash,
    activeHash,
    selectedHashes,
    pushCustomUndo,
    addLog,
    setError,
    setAutoMatchNotice,
    setActiveBulkPopover,
  } = core;
  // Inspector Single-Photo Location Editor State
  const [isEditingInspectorLocation, setIsEditingInspectorLocation] = useState<boolean>(false);
  const [inspectorLocationQuery, setInspectorLocationQuery] = useState<string>("");
  // Click-on-Map GPS Picker Mode
  const [isPickingMapLocation, setIsPickingMapLocation] = useState<boolean>(false);
  // City search has its own text, so typing a city never overwrites the tag/person/move input
  const [cityQuery, setCityQuery] = useState<string>("");
  const [citySearchResults, setCitySearchResults] = useState<CitySearchResult[]>([]);

  // A newly opened photo starts with its location editor closed
  useEffect(() => {
    setIsEditingInspectorLocation(false);
  }, [activeHash]);

  // Undo step for a location change: undo restores every photo's previous place (one backend call per
  // distinct previous value), redo applies the new value again
  function pushLocationUndo(
    description: string,
    hashes: string[],
    next: (previous: LocationValue) => LocationValue,
    redoArgs: { location: string; latitude: number | null; longitude: number | null }
  ) {
    const before = new Map<string, LocationValue>();
    for (const h of hashes) {
      const p = photoByHash.get(h);
      if (p) before.set(h, { location: p.location, latitude: p.latitude ?? null, longitude: p.longitude ?? null });
    }
    if (before.size === 0) return;
    const applyLocal = (values: Map<string, LocationValue>) =>
      setPhotos((prev) =>
        prev.map((p) => {
          const v = values.get(p.hash);
          return v ? { ...p, ...v } : p;
        })
      );
    const targets = Array.from(before.keys());
    pushCustomUndo(
      description,
      targets,
      async () => {
        const groups = new Map<string, { value: LocationValue; hashes: string[] }>();
        for (const [h, v] of before) {
          const key = `${v.location}|${v.latitude}|${v.longitude}`;
          const g = groups.get(key) || { value: v, hashes: [] };
          g.hashes.push(h);
          groups.set(key, g);
        }
        for (const g of groups.values()) {
          await call("set_manual_location", { hashes: g.hashes, ...g.value });
        }
        applyLocal(before);
      },
      async () => {
        await call("set_manual_location", { hashes: targets, ...redoArgs });
        applyLocal(new Map(targets.map((h) => [h, next(before.get(h)!)])));
      }
    );
  }

  // Typing a city searches after a short pause; only the newest search may update the results
  const citySearchSeqRef = useRef(0);
  const citySearchTimerRef = useRef<number | undefined>(undefined);
  async function handleSearchCities(q: string) {
    setCityQuery(q);
    window.clearTimeout(citySearchTimerRef.current);
    const seq = ++citySearchSeqRef.current;
    if (q.trim().length < 2) {
      setCitySearchResults([]);
      return;
    }
    citySearchTimerRef.current = window.setTimeout(async () => {
      try {
        const matches = await call<CitySearchResult[]>("search_cities_offline", { query: q });
        if (seq === citySearchSeqRef.current) setCitySearchResults(matches);
      } catch {}
    }, 150);
  }

  async function handleAssignCity(c: CitySearchResult) {
    const targets =
      selectedHashes.size > 0
        ? Array.from(selectedHashes)
        : activeHash
        ? [activeHash]
        : [];
    if (targets.length === 0) return;
    try {
      const value: LocationValue = {
        location: `${c.name}, ${c.country}`,
        latitude: c.latitude,
        longitude: c.longitude,
      };
      await call("set_manual_location", { hashes: targets, ...value });
      pushLocationUndo(`Location "${value.location}" on ${targets.length} photo(s)`, targets, () => value, value);
      const targetSet = new Set(targets);
      setPhotos((prev) => prev.map((p) => (targetSet.has(p.hash) ? { ...p, ...value } : p)));
      addLog("TRIAGE", `Assigned location "${value.location}" to ${targets.length} photo(s)`);
      setActiveBulkPopover(null);
      setIsEditingInspectorLocation(false);
      setCitySearchResults([]);
      setCityQuery("");
      setInspectorLocationQuery("");
    } catch (err) {
      setError(String(err));
    }
  }

  async function handleAssignCustomLocationText(customLoc: string) {
    const clean = customLoc.trim();
    const targets =
      selectedHashes.size > 0
        ? Array.from(selectedHashes)
        : activeHash
        ? [activeHash]
        : [];
    if (targets.length === 0) return;
    // A typed place name keeps the photos' GPS coordinates; clearing the name clears them too
    const nextValue = (prev: LocationValue): LocationValue => ({
      location: clean,
      latitude: clean ? prev.latitude : null,
      longitude: clean ? prev.longitude : null,
    });
    try {
      const redoArgs = { location: clean, latitude: null, longitude: null };
      await call("set_manual_location", { hashes: targets, ...redoArgs });
      pushLocationUndo(
        clean ? `Location "${clean}" on ${targets.length} photo(s)` : `Clear location on ${targets.length} photo(s)`,
        targets,
        nextValue,
        redoArgs
      );
      const targetSet = new Set(targets);
      setPhotos((prev) =>
        prev.map((p) =>
          targetSet.has(p.hash)
            ? { ...p, ...nextValue({ location: p.location, latitude: p.latitude ?? null, longitude: p.longitude ?? null }) }
            : p
        )
      );
      addLog("TRIAGE", `Set custom location "${clean || "cleared"}" on ${targets.length} photo(s)`);
      setIsEditingInspectorLocation(false);
      setActiveBulkPopover(null);
      setInspectorLocationQuery("");
      setCityQuery("");
    } catch (err) {
      setError(String(err));
    }
  }

  async function handleMapPickCoordinates(lat: number, lon: number) {
    if (selectedHashes.size === 0) return;
    try {
      const hashes = expandWithLivePairs(expandWithRawPairs(Array.from(selectedHashes), photos), photos);
      const hashSet = new Set(hashes);
      const location = await call<string>("set_manual_location", {
        hashes,
        location: "",
        latitude: lat,
        longitude: lon,
      });
      const value: LocationValue = { location, latitude: lat, longitude: lon };
      pushLocationUndo(`Map location on ${hashes.length} photo(s)`, hashes, () => value, value);
      // Patch just these photos (this used to rescan the whole folder)
      setPhotos((prev) => prev.map((p) => (hashSet.has(p.hash) ? { ...p, ...value } : p)));
      setIsPickingMapLocation(false);
      addLog("TRIAGE", `Assigned map GPS (${lat.toFixed(4)}, ${lon.toFixed(4)}) to ${hashes.length} photo(s)`);
      setAutoMatchNotice(
        `Assigned GPS (${lat.toFixed(4)}, ${lon.toFixed(4)}) to ${hashes.length} photo(s)!`
      );
    } catch (err) {
      setError(String(err));
    }
  }

  return {
    isEditingInspectorLocation,
    setIsEditingInspectorLocation,
    inspectorLocationQuery,
    setInspectorLocationQuery,
    isPickingMapLocation,
    setIsPickingMapLocation,
    cityQuery,
    citySearchResults,
    setCitySearchResults,
    handleSearchCities,
    handleAssignCity,
    handleAssignCustomLocationText,
    handleMapPickCoordinates,
  };
}
