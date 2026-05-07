// YTC: passthrough Stack for the (auth) group (login, pending).
import { Stack } from "expo-router";
export default function YtcAuthLayout() { return <Stack screenOptions={{ headerShown: false }} />; }
