# Rust calls these by name over JNI (android_jni.rs: Native, PhoneStore, TokenStore) and Tauri finds the plugin
# by its class name: the release build's shrinking must leave the app's own classes as they are
-keep class com.amazhr.lumina.** { *; }
# WorkManager (the background backup) makes its Room database and its own workers by reflection; without these the
# release build drops their constructors and the app crashes as it starts (WorkDatabase_Impl.<init>)
-keep class * extends androidx.room.RoomDatabase { <init>(); }
-keep class * extends androidx.work.ListenableWorker { <init>(android.content.Context, androidx.work.WorkerParameters); }
-keep class * extends androidx.work.InputMerger { <init>(); }
