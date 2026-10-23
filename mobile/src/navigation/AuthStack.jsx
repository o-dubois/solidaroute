/**
 * AuthStack — state-based auth navigator (no native stack dependency).
 *
 * Passes a minimal `navigation` object to each screen so they can call
 * navigation.navigate('Login' | 'Register' | 'ForgotPassword') as normal.
 */
import { useState } from 'react';
import LoginScreen          from '../screens/auth/LoginScreen';
import RegisterScreen       from '../screens/auth/RegisterScreen';
import ForgotPasswordScreen from '../screens/auth/ForgotPasswordScreen';

const SCREENS = {
  Login:          LoginScreen,
  Register:       RegisterScreen,
  ForgotPassword: ForgotPasswordScreen,
};

export default function AuthStack() {
  const [screen, setScreen] = useState('Login');

  const navigation = {
    navigate: (name) => { if (SCREENS[name]) setScreen(name); },
    goBack:   ()     => setScreen('Login'),
  };

  const Screen = SCREENS[screen] || LoginScreen;
  return <Screen navigation={navigation} />;
}
