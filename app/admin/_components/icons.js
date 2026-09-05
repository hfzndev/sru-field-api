/*
 * The panel's icon set, in one place.
 *
 * Everything comes from Phosphor at a single weight. The old set was emoji,
 * which rendered as a different picture on every operator's machine and made
 * the nav look unfinished next to real type.
 *
 * Imported from `/ssr` on purpose: those builds are plain SVG with no React
 * context, so the same import works in a server component (the 404 page, the
 * public stub) and a client one (every admin page). Importing from the package
 * root would drag a provider into the tree and break the server pages.
 *
 * Re-exported here rather than imported per page so the weight and the default
 * size are decided once. If the set ever needs to get heavier, it changes here.
 */
import {
  Broom,
  CaretRight,
  CheckCircle,
  ClipboardText,
  Crane,
  Cylinder,
  DeviceMobile,
  DownloadSimple,
  FolderOpen,
  Gauge,
  Gear,
  HardHat,
  MagnifyingGlass,
  MoonStars,
  PencilSimple,
  Plus,
  SignOut,
  WarningCircle,
  Wrench,
  X,
} from '@phosphor-icons/react/ssr';

/** One weight for the whole panel. Mixing weights is what makes an icon set look borrowed. */
export const ICON_WEIGHT = 'regular';

/** Sizes, so call sites ask for a role rather than a number. */
export const ICON = {
  inline: 16,  // beside text in a button or a chip
  nav: 22,     // tab bar
  tile: 20,    // dashboard tile corner
  empty: 32,   // empty-state mark
};

export {
  Broom,
  CaretRight,
  CheckCircle,
  ClipboardText,
  Crane,
  Cylinder,
  DeviceMobile,
  DownloadSimple,
  FolderOpen,
  Gauge,
  Gear,
  HardHat,
  MagnifyingGlass,
  MoonStars,
  PencilSimple,
  Plus,
  SignOut,
  WarningCircle,
  Wrench,
  X,
};
