module.exports = function (api) {
  api.cache(true);
  // Jest sets NODE_ENV=test. The nativewind/babel preset pulls in CSS-interop
  // transforms that assume a React Native runtime and break plain-node unit
  // tests; the app build still gets it. Pure-logic tests don't render JSX.
  // reanimated:false prevents babel-preset-expo from requiring the Worklet compiler
  // plugin (react-native-worklets/plugin), which is a native addon unavailable in Node.
  const isTest = process.env.NODE_ENV === 'test';
  return {
    presets: [
      [
        'babel-preset-expo',
        {
          jsxImportSource: 'nativewind',
          ...(isTest ? { reanimated: false } : {}),
        },
      ],
      ...(isTest ? [] : ['nativewind/babel']),
    ],
  };
};
