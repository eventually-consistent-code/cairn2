// Docs connector SPI — sibling of the tracker SPI (tracker/types.ts).
// Trackers manage work items; docs connectors publish documentation trees.
// The SPI stays product-agnostic: bodies cross the boundary as markdown and
// each adapter owns the conversion to its native storage format.
export {};
