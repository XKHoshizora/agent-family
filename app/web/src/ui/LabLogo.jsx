import React from "react";
import { ModelBrand } from "./ModelBrand.jsx";
import { brandOf } from "./modelBrands.js";

// A model's mark where a model is named outside the picker (the Agent list and page, the line under a reply, the provider
// pages): the app's one set of brand marks (src/ui/ModelBrand.jsx, bundled lobe-icons) under the names its callers have
// always used. `lab` is a brand (src/ui/modelBrands.js BRANDS); anything else draws the generic mark.

/** The brand's mark as a small decorative image (`size` px, 18 by default), or the generic mark. */
export function LabLogo({ lab, size = 18 }) {
  return <ModelBrand brand={lab} size={size} className="lab-logo" />;
}

/** The brand of a model's name (`brandOf`), or null. */
export const labOfModel = brandOf;
