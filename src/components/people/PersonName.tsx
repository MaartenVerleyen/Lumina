import { openLibraryIsAll } from "../../api";
import { splitApartName } from "../../api/allPhotos";

// A person's name as the window shows it. In All photos, one kept apart from a person of the same name
// elsewhere carries its library ("Emma (cachy)"): that goes in a small label of its own, so a narrow list cuts
// the name, not the library, and the library keeps its own spelling.
export function PersonName({ name }: { name: string }) {
  const apart = openLibraryIsAll() ? splitApartName(name) : null;
  if (!apart) return <span className="capitalize truncate">{name}</span>;
  return (
    <>
      <span className="capitalize truncate">{apart.base}</span>
      <span className="shrink-0 text-[10px] font-normal normal-case text-zinc-400">{apart.library}</span>
    </>
  );
}
