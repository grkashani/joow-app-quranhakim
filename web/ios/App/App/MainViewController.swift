//
//  MainViewController.swift
//  App (JoowQuran)
//
//  Custom Capacitor bridge view controller. App-local plugins on an SPM-based Capacitor 8
//  project have NO auto-discovery, so we register the instance here in capacitorDidLoad().
//
//  WIRING (required — without it JS reports "not implemented on iOS"):
//    Base.lproj/Main.storyboard → Bridge View Controller scene → Identity inspector:
//      Custom Class = MainViewController   (Module = App, "Inherit Module From Target" ON)
//  (Already applied in this repo's Main.storyboard.)
//

import UIKit
import Capacitor

class MainViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(SpeechToTextPlugin())
    }
}
