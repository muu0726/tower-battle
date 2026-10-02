declare module "poly-decomp" {
  type Point = [number, number];
  type Polygon = Point[];
  const decomp: {
    decomp(polygon: Polygon): Polygon[] | false;
    quickDecomp(polygon: Polygon): Polygon[];
    isSimple(polygon: Polygon): boolean;
    makeCCW(polygon: Polygon): boolean;
    removeCollinearPoints(polygon: Polygon, thresholdAngle?: number): number;
    removeDuplicatePoints(polygon: Polygon, precision?: number): void;
  };
  export default decomp;
}
