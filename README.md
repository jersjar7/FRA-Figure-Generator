# FRA Figure Generator

Client-side dashboard for generating Flood Risk Assessment figures from SRH-2D/SMS XMDF `.h5` exports.

The first version focuses on the SMS-derived figures that are difficult to export cleanly from SMS:

- Existing vs proposed 100-year WSE difference maps
- Newly inundated / newly dry areas
- Proposed inundation plus ground elevation maps
- Proposed-condition cross-section figures from a centerline and station list
- Observation-line WSE comparison charts
- Existing/proposed WSE summary tables
- Anchor and nudge controls for built-in map elements such as legends, north arrow, scale bar, and wet/dry key

Everything runs in the browser. Mesh/result files are read locally and are not uploaded to a server.

## Inputs

- Existing geometry `.h5`
- Existing datasets `.h5`
- Proposed geometry `.h5`
- Proposed datasets `.h5`
- Optional zipped shapefiles for ROW, parcels, FEMA/SFHA, project limits, observation lines, etc.
- Optional centerline shapefile for proposed-condition cross sections
- Optional SMS Summary Table paste for station labels

Required SMS datasets for the FRA workflow:

- `Water_Elev_ft`
- `Water_Depth_ft`
- `Velocity_ft_p_s`
- Mesh `Z` from geometry

## Deployment

This repository deploys to GitHub Pages using the workflow in `.github/workflows/pages.yml`.
