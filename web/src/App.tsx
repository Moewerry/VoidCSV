import React from 'react'
import { Navigate, Route, Routes } from 'react-router-dom'
import Home from './pages/Home'
import Viewer from './pages/Viewer'

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Home />} />
      <Route path="/viewer" element={<Viewer />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}

