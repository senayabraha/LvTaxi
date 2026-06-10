// Unit-test harness for pure logic (classifier, eligibility, geo/polygon
// confirmation, TTL boundaries). Tests deliberately import only dependency-free
// modules (plus @turf for geometry) so they run in a plain Node environment
// without the React Native / Expo runtime.
module.exports = {
  testEnvironment: 'node',
  transform: {
    '^.+\\.[jt]sx?$': 'babel-jest',
  },
  // @turf ships as ESM and must be transformed; everything else in node_modules
  // is left as-is so the suite stays fast.
  transformIgnorePatterns: ['/node_modules/(?!(@turf)/)'],
  testMatch: ['**/__tests__/**/*.test.js'],
  clearMocks: true,
};
