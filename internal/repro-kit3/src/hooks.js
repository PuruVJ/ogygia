// A custom type the app teaches Kit: Kit 3 encodes remote ARGUMENTS with it from a module only its
// client boot fills — so on a csr=false page ogygia must fill it (the PointSum island).
import { Point } from '#lib/point.js';

export const transport = {
	Point: {
		encode: (v) => v instanceof Point && [v.x, v.y],
		decode: ([x, y]) => new Point(x, y)
	}
};
