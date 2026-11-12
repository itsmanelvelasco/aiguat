# AIGUAT – Catalonia Flood Lab

3D flood early-warning lab for Catalonia, built on public data. Plain HTML/CSS/ES modules, no build step.

## Run

```
python3 -m http.server 8080
# open http://localhost:8080/
```

## What it does

- **3D terrain + local flood model**: click anywhere to fetch Terrarium elevation tiles and run a terrain-based HAND (height above nearest drainage) model in the browser, with river-stage and storm-surge sliders.
- **Catalonia-wide screening layer**: `data/catalonia.png`, precomputed with `tools/build-catalonia.html` (230 m grid, main rivers only).
- **Official flood zones**: SNCZI T10/T100/T500 and coastal WMS overlays, IoU validation and auto-calibration (river level + stream-network density).
- **ACA live data** (Socrata, analisi.transparenciacatalunya.cat): river gauges (`2bwe-vgpr`, real-time `3yr3-vq6y`), reservoirs (`gn9e-3qhr`), sewer overflows (`qb78-67ft`).
- **Dam regulation**: upstream reservoir spare capacity attenuates the river stage. **Dam-break**: indicative wave (Froehlich peak outflow, simple attenuation) below any ACA dam.
- **Hyper-local alerts**: 250 m alert blocks, streets and buildings at risk, address lookup (ICGC geocoder), ES-Alert/SMS/push drafts in Català/Español/English. Sending is simulated.
- **Street detail**: ICGC 25 cm orthophoto, OpenFreeMap streets and 3D buildings.

## Limits

Terrain-only model at ~30 m resolution: no hydraulics, embankments or river walls. Dam regulation and dam-break are indicative. Not for real emergency decisions.
