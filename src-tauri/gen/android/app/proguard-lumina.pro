# Rust calls these by name over JNI (android_jni.rs: Native, PhoneStore, TokenStore) and Tauri finds the plugin
# by its class name: the release build's shrinking must leave the app's own classes as they are
-keep class com.amazhr.lumina.** { *; }
