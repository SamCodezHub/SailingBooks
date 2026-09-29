// Vercel currently exposes the catch-all function for one path segment only
// in this static-output deployment. vercel.json rewrites nested cloud routes
// here and carries their original segments in the `route` query parameter.
module.exports = require('./[...route].js');
