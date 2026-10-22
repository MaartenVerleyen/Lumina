import { useEffect } from "react";
import { MapContainer, TileLayer, Marker, Popup, useMapEvents } from "react-leaflet";
import L from "leaflet";
import { convertFileSrc } from "@tauri-apps/api/core";

// Fix default Leaflet marker icons in Vite
const markerIcon = new L.Icon({
  iconUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png",
  iconRetinaUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png",
  shadowUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png",
  iconSize: [25, 41],
  iconAnchor: [12, 41],
  popupAnchor: [1, -34],
  shadowSize: [41, 41],
});

export interface MapPhotoItem {
  hash: string;
  name: string;
  path: string;
  thumb_path: string;
  thumb_ready: boolean;
  location: string;
  latitude?: number | null;
  longitude?: number | null;
  captured_at: string;
}

interface PhotoMapProps {
  photos: MapPhotoItem[];
  onSelectPhoto: (hash: string) => void;
  isPickingLocation?: boolean;
  onMapPickCoordinates?: (lat: number, lon: number) => void;
}

function MapClickHandler({
  isPickingLocation,
  onMapPickCoordinates,
}: {
  isPickingLocation?: boolean;
  onMapPickCoordinates?: (lat: number, lon: number) => void;
}) {
  useMapEvents({
    click(e) {
      if (isPickingLocation && onMapPickCoordinates) {
        onMapPickCoordinates(e.latlng.lat, e.latlng.lng);
      }
    },
  });
  return null;
}

export default function PhotoMap({
  photos,
  onSelectPhoto,
  isPickingLocation = false,
  onMapPickCoordinates,
}: PhotoMapProps) {
  const gpsPhotos = photos.filter(
    (p) => typeof p.latitude === "number" && typeof p.longitude === "number"
  );

  // Default center: Meise / Brussels, Belgium if no GPS photos exist yet
  const defaultCenter: [number, number] =
    gpsPhotos.length > 0
      ? [gpsPhotos[0].latitude as number, gpsPhotos[0].longitude as number]
      : [50.9333, 4.3333];

  useEffect(() => {
    const container = document.querySelector(".leaflet-container") as HTMLElement | null;
    if (container) {
      container.style.cursor = isPickingLocation ? "crosshair" : "";
    }
  }, [isPickingLocation]);

  return (
    <div className="relative flex-1 w-full h-full overflow-hidden">
      <MapContainer
        center={defaultCenter}
        zoom={gpsPhotos.length > 0 ? 6 : 5}
        className="w-full h-full z-0"
      >
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />

        <MapClickHandler
          isPickingLocation={isPickingLocation}
          onMapPickCoordinates={onMapPickCoordinates}
        />

        {gpsPhotos.map((p) => (
          <Marker
            key={p.hash}
            position={[p.latitude as number, p.longitude as number]}
            icon={markerIcon}
            eventHandlers={{
              click: () => onSelectPhoto(p.hash),
            }}
          >
            <Popup>
              <div className="flex flex-col gap-1.5 w-40 text-xs text-slate-900">
                <img
                  src={convertFileSrc(p.thumb_ready ? p.thumb_path : p.path)}
                  alt={p.name}
                  className="w-full h-24 object-cover rounded"
                />
                <div className="font-bold truncate">{p.name}</div>
                {p.location && <div className="text-[11px] text-emerald-700">📍 {p.location}</div>}
                {p.captured_at && (
                  <div className="text-[10px] text-slate-500">
                    📅 {p.captured_at.split(" ")[0].replace(/:/g, "-")}
                  </div>
                )}
              </div>
            </Popup>
          </Marker>
        ))}
      </MapContainer>
    </div>
  );
}
