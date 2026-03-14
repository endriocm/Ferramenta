import { useContext } from 'react'
import { ToastContext } from '../components/toastContext'

export const useToast = () => useContext(ToastContext)

