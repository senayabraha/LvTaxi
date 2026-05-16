import React from 'react';
import { View, Text, Pressable } from 'react-native';

export default class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error('[ErrorBoundary]', error, info?.componentStack);
  }

  reset = () => {
    this.setState({ error: null });
  };

  render() {
    if (this.state.error) {
      return (
        <View className="flex-1 bg-bg items-center justify-center p-6">
          <Text className="text-accent text-2xl font-bold mb-3">
            Something broke
          </Text>
          <Text className="text-text text-center mb-6">
            {String(this.state.error?.message ?? this.state.error)}
          </Text>
          <Pressable
            onPress={this.reset}
            className="bg-accent rounded-lg px-6 py-3"
          >
            <Text className="text-bg font-bold">Try again</Text>
          </Pressable>
        </View>
      );
    }
    return this.props.children;
  }
}
