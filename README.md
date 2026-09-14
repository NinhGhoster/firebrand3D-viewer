# Firebrand3D viewer

A browser viewer for the Firebrand3D characterisation dataset: **7,663 firebrands**
reconstructed in three dimensions from **372 controlled burning experiments**, paired with the
visible-light and thermal recordings of the burns that produced them.

Live at **https://firebrand3d.flarewildfire.app/**

A firebrand is a burning fragment of vegetation carried ahead of a fire. Where it lands
decides whether a fire spreads by spotting, and that depends on its shape, size and density.
Fire behaviour models have had to assume firebrands are discs, cylinders or spheres, because
measured three-dimensional shapes did not exist. This dataset is that measurement.

## What the viewer does

- Browse experiments by fuel family, with facets that follow the family — bark hazard rating
  applies only to fibrous bark, sample length only to candlebark, fuel structure only to
  branchlet
- Play every recording of an experiment, including continuation segments
- Inspect any firebrand's mesh in 3D, with its measured volume, surface area, V/Sa, bounding
  dimensions, mass and density
- See the data-quality note attached to each measurement, so a mass at the balance's
  readability floor is not mistaken for a reading

## Layout

| file | role |
|---|---|
| `index.html` | page structure, importmap for the vendored libraries |
| `app.js` | data loading, filtering, the run tree, the three.js viewport |
| `index.css` | styling and the responsive tiers |
| `build_database.py` | builds `database.json` from the release's index files |
| `DEPLOY.md` | how the site is deployed and how to rebuild the catalogue |

`database.json` and `vendor/` are generated and not committed. See `DEPLOY.md`.

## Building the catalogue

```bash
python3 build_database.py /path/to/level2 database.json
```

It reads `firebrand_manifest.csv`, `experiment_media.csv` and
`thermal_acquisition_parameters.csv` from the release — it does **not** walk the directory
tree, so a restructure of the dataset does not break it as long as those index files are
regenerated first.

Two details worth knowing if you work with this data:

- Join on `firebrand_uid`, not the file ID. The release holds 7,663 firebrands but only 6,398
  distinct file IDs — `S10a_mesh_1` recurs between fuel trees.
- A trailing letter on a section (`S13a`, `S13b`) marks a continuation segment of one
  recording, not a separate experiment.

## The dataset

Described in the accompanying data descriptor. The three fuel families — branchlet, fibrous
bark and candlebark — were chosen to span the morphological classes that firebrand transport
models have to represent.

## Requirements

A browser with WebGL. three.js and the Draco decoder are served from the same host rather than
a CDN, so the viewer keeps working if a CDN is unreachable.
