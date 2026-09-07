package com.familytube

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest

/**
 * Watches Wi-Fi/cellular connectivity and reports changes. Used by
 * MainActivity to auto-reload after an outage and by the JS bridge's
 * `isNetworkAvailable()`.
 */
class NetworkMonitor(
    private val context: Context,
    private val onNetworkChange: (Boolean) -> Unit
) {

    private var networkCallback: ConnectivityManager.NetworkCallback? = null
    private var monitoring = false

    fun isConnected(): Boolean {
        val cm = context.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
        val capabilities = cm.getNetworkCapabilities(cm.activeNetwork) ?: return false
        return capabilities.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) ||
            capabilities.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR)
    }

    fun startMonitoring() {
        if (monitoring) return // never double-register (onCreate → onResume)

        val cm = context.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
        val request = NetworkRequest.Builder()
            .addTransportType(NetworkCapabilities.TRANSPORT_WIFI)
            .addTransportType(NetworkCapabilities.TRANSPORT_CELLULAR)
            .build()

        val callback = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) {
                super.onAvailable(network)
                onNetworkChange(true)
            }

            override fun onLost(network: Network) {
                super.onLost(network)
                onNetworkChange(false)
            }

            override fun onCapabilitiesChanged(
                network: Network,
                networkCapabilities: NetworkCapabilities
            ) {
                super.onCapabilitiesChanged(network, networkCapabilities)
                // Reserved for a future "on cellular data" meter warning.
                val isMetered = !networkCapabilities.hasCapability(
                    NetworkCapabilities.NET_CAPABILITY_NOT_METERED
                )
                if (isMetered) { /* on cellular data — could warn about usage */ }
            }
        }

        cm.registerNetworkCallback(request, callback)
        networkCallback = callback
        monitoring = true
    }

    fun stopMonitoring() {
        if (!monitoring) return
        val cm = context.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
        networkCallback?.let { cm.unregisterNetworkCallback(it) }
        networkCallback = null
        monitoring = false
    }
}
