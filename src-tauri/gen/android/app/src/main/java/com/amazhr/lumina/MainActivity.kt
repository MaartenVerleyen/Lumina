package com.amazhr.lumina

import android.content.pm.ApplicationInfo
import android.graphics.Color
import android.graphics.drawable.ColorDrawable
import android.os.Bundle
import android.view.View
import android.view.WindowManager
import androidx.activity.SystemBarStyle
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    // Before Rust starts: it reads the sessions (TokenStore) as it loads the server list
    Native.init(this)
    // Lumina is dark: light status and navigation bar icons, on the app's own background
    enableEdgeToEdge(
      statusBarStyle = SystemBarStyle.dark(Color.TRANSPARENT),
      navigationBarStyle = SystemBarStyle.dark(Color.TRANSPARENT),
    )
    super.onCreate(savedInstanceState)
    window.setBackgroundDrawable(ColorDrawable(Color.rgb(9, 10, 15)))
    // A debug build (tried on a phone over USB) keeps the screen on while it is in front
    if (applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE != 0) {
      window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
    }
    // Android draws apps edge to edge: the web view keeps clear of the status bar, the navigation bar and a
    // camera cutout, so the header and the bottom tabs aren't under them
    val content = findViewById<View>(android.R.id.content)
    ViewCompat.setOnApplyWindowInsetsListener(content) { view, insets ->
      val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
      view.setPadding(bars.left, bars.top, bars.right, bars.bottom)
      WindowInsetsCompat.CONSUMED
    }
  }
}
