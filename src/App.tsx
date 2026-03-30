import { useState, useEffect, useRef, useCallback } from 'react';
import { 
  ChevronDown, Sparkles, Check, Search, Star, Menu, X,
  Palette, Zap, CreditCard, Users, Image as ImageIcon,
  Type, BookOpen, Download, ArrowRight, Play, Heart,
  Upload, MessageSquare, Layers, Grid3X3, List, Filter,
  Clock, Shield, Mail,
  Facebook, Twitter, Instagram, Youtube, Linkedin,
  Eye, Wand2, PenTool, ScanLine, Paintbrush,
  Share2, Bookmark, Undo, Redo, Eraser, Loader2
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import inkbloomLogo from '@/assets/inkbloom-logo.svg';
import type { User } from 'firebase/auth';
import { onAuthStateChanged, signInWithPopup, signOut } from 'firebase/auth';
import { addDoc, collection, doc, serverTimestamp, setDoc } from 'firebase/firestore';
import { auth, db, googleProvider } from '@/lib/firebase';

const POLLINATIONS_UPLOAD_URL = 'https://media.pollinations.ai/upload'
const POLLINATIONS_IMAGE_BASE = 'https://image.pollinations.ai/prompt'

function scrollToSection(sectionId: string) {
  const id = sectionId.startsWith('#') ? sectionId.slice(1) : sectionId;
  const el = document.getElementById(id);
  if (!el) return;
  el.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function openOnlineColoring(imageUrl: string) {
  window.dispatchEvent(
    new CustomEvent('online-coloring:set-image', { detail: { url: imageUrl } })
  )
  scrollToSection('online-coloring')
}

function getOrCreateSessionId() {
  const key = 'INKBLOOM_SESSION_ID'
  try {
    const existing = localStorage.getItem(key)
    if (existing) return existing
    const value =
      typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? (crypto as Crypto).randomUUID()
        : `${Date.now()}-${Math.random().toString(16).slice(2)}`
    localStorage.setItem(key, value)
    return value
  } catch {
    return `${Date.now()}-${Math.random().toString(16).slice(2)}`
  }
}

function buildPollinationsImageUrl(
  prompt: string,
  params: Record<string, string | number | boolean | null | undefined>
) {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value === null || value === undefined) continue
    search.set(key, String(value))
  }
  const qs = search.toString()
  return `${POLLINATIONS_IMAGE_BASE}/${encodeURIComponent(prompt)}${qs ? `?${qs}` : ''}`
}

async function uploadToPollinations(file: File, signal?: AbortSignal) {
  const form = new FormData()
  form.append('file', file)
  const res = await fetch(POLLINATIONS_UPLOAD_URL, { method: 'POST', body: form, signal })
  const text = await res.text()
  if (!res.ok) throw new Error(text || 'Upload failed')
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    throw new Error('Upload returned invalid JSON')
  }
  if (!json || typeof json !== 'object') throw new Error('Upload returned invalid JSON')
  const record = json as Record<string, unknown>
  const urlValue =
    typeof record.url === 'string' ? record.url : typeof record.hash_url === 'string' ? record.hash_url : null
  if (!urlValue) throw new Error('Upload response missing url')
  return urlValue
}

function preloadImage(url: string, timeoutMs = 120_000) {
  return new Promise<void>((resolve, reject) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    const timeout = window.setTimeout(() => {
      reject(new Error('Generation timed out, please try again'))
    }, timeoutMs)
    img.onload = () => {
      window.clearTimeout(timeout)
      resolve()
    }
    img.onerror = () => {
      window.clearTimeout(timeout)
      reject(new Error('Generation failed, please try again'))
    }
    img.src = url
  })
}

function makePollinationsSeed() {
  const max = 2147483647
  const value = Date.now() % max
  return String(value <= 0 ? 1 : value)
}

// ==================== NAVIGATION ====================
type HeaderProps = {
  user: User | null
  onSignIn: () => void
  onSignOut: () => void
  isSigningIn: boolean
}

function Header({ user, onSignIn, onSignOut, isSigningIn }: HeaderProps) {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [activeDropdown, setActiveDropdown] = useState<string | null>(null);
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const handleScroll = () => setScrolled(window.scrollY > 20);
    window.addEventListener('scroll', handleScroll);
    return () => window.removeEventListener('scroll', handleScroll);
  }, []);

  const navItems = [
    {
      label: 'Free Coloring Pages',
      href: '#gallery',
      dropdown: [
        { label: 'Animals', href: '#', icon: '🐾' },
        { label: 'Cartoons', href: '#', icon: '🎨' },
        { label: 'Holidays', href: '#', icon: '🎄' },
        { label: 'Fantasy', href: '#', icon: '🦄' },
        { label: 'Nature', href: '#', icon: '🌸' },
        { label: 'View All', href: '#gallery', icon: '→' },
      ]
    },
    {
      label: 'AI Generators',
      href: '#',
      dropdown: [
        { label: 'Photo to Coloring Page', href: '#photo-feature', icon: '📸' },
        { label: 'Text to Coloring Page', href: '#text-feature', icon: '✏️' },
        { label: 'Coloring Book Generator', href: '#book-feature', icon: '📚' },
        { label: 'AI Image Editor', href: '#edit-feature', icon: '🪄' },
        { label: 'Colorize Drawing', href: '#colorize-feature', icon: '🎨' },
      ]
    },
    {
      label: 'Coloring Book Generator',
      href: '#book-feature',
      badge: 'New',
    },
    { label: 'Online Coloring', href: '#online-coloring' },
    { label: 'Gallery', href: '#gallery' },
  ];

  return (
    <header className={`sticky top-0 z-50 transition-all duration-300 ${scrolled ? 'bg-white/95 backdrop-blur-md shadow-lg' : 'bg-white'}`}>
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex items-center justify-between h-16 lg:h-20">
          {/* Logo */}
          <a href="#" className="flex items-center gap-2 group">
            <div className="w-10 h-10 lg:w-12 lg:h-12 rounded-xl bg-gradient-to-br from-indigo-500 via-fuchsia-500 to-emerald-400 flex items-center justify-center group-hover:scale-110 transition-transform">
              <img src={inkbloomLogo} alt="InkBloom" className="w-6 h-6 lg:w-7 lg:h-7" />
            </div>
            <div className="flex flex-col">
              <span className="text-lg lg:text-xl font-bold leading-tight">
                <span className="text-indigo-600">Ink</span>
                <span className="text-emerald-500">Bloom</span>
              </span>
              <span className="text-xs text-gray-400 hidden sm:block">AI Coloring Studio</span>
            </div>
          </a>

          {/* Desktop Navigation */}
          <nav className="hidden lg:flex items-center gap-1">
            {navItems.map((item, index) => (
              <div 
                key={index}
                className="relative"
                onMouseEnter={() => item.dropdown && setActiveDropdown(item.label)}
                onMouseLeave={() => setActiveDropdown(null)}
              >
                <a 
                  href={item.href}
                  className="flex items-center gap-1 px-4 py-2 text-gray-700 hover:text-indigo-600 font-medium rounded-lg hover:bg-indigo-50 transition-colors"
                >
                  {item.label}
                  {item.badge && (
                    <Badge className="ml-1 bg-gradient-to-r from-indigo-600 to-emerald-500 text-white text-xs">{item.badge}</Badge>
                  )}
                  {item.dropdown && <ChevronDown className="w-4 h-4" />}
                </a>
                
                {/* Dropdown Menu */}
                {item.dropdown && activeDropdown === item.label && (
                  <div className="absolute top-full left-0 mt-1 w-64 bg-white rounded-xl shadow-xl border border-gray-100 overflow-hidden animate-in fade-in slide-in-from-top-2">
                    <div className="p-2">
                      {item.dropdown.map((subItem, subIndex) => (
                        <a
                          key={subIndex}
                          href={subItem.href}
                          className="flex items-center gap-3 px-4 py-3 rounded-lg hover:bg-indigo-50 text-gray-700 hover:text-indigo-600 transition-colors"
                        >
                          <span className="text-xl">{subItem.icon}</span>
                          <span className="font-medium">{subItem.label}</span>
                        </a>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            ))}
          </nav>

          {/* CTA Buttons */}
          <div className="hidden lg:flex items-center gap-3">
            {user ? (
              <div className="flex items-center gap-2">
                <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-gray-50">
                  {user.photoURL ? (
                    <img src={user.photoURL} alt="User" className="w-7 h-7 rounded-full" />
                  ) : (
                    <div className="w-7 h-7 rounded-full bg-indigo-100 flex items-center justify-center">
                      <Users className="w-4 h-4 text-indigo-600" />
                    </div>
                  )}
                  <span className="text-sm text-gray-700 max-w-40 truncate">
                    {user.displayName ?? user.email ?? 'Account'}
                  </span>
                </div>
                <Button variant="ghost" className="text-gray-600 hover:text-indigo-600" onClick={onSignOut}>
                  Sign Out
                </Button>
              </div>
            ) : (
              <Button
                variant="ghost"
                className="text-gray-600 hover:text-indigo-600"
                onClick={onSignIn}
                disabled={isSigningIn}
              >
                {isSigningIn && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
                Sign In
              </Button>
            )}
            <Button
              onClick={() => scrollToSection('text-feature')}
              className="bg-gradient-to-r from-indigo-600 to-emerald-500 hover:from-indigo-700 hover:to-emerald-600 text-white px-6"
            >
              <Sparkles className="w-4 h-4 mr-2" />
              Get Started Free
            </Button>
          </div>

          {/* Mobile Menu Button */}
          <button 
            className="lg:hidden p-2 hover:bg-gray-100 rounded-lg transition-colors"
            onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
          >
            {mobileMenuOpen ? <X className="w-6 h-6" /> : <Menu className="w-6 h-6" />}
          </button>
        </div>
      </div>

      {/* Mobile Menu */}
      {mobileMenuOpen && (
        <div className="lg:hidden bg-white border-t border-gray-100">
          <ScrollArea className="h-[calc(100vh-80px)]">
            <div className="p-4 space-y-2">
              {navItems.map((item, index) => (
                <div key={index}>
                  <a 
                    href={item.href}
                    className="flex items-center justify-between p-3 text-gray-700 font-medium rounded-lg hover:bg-indigo-50"
                    onClick={() => !item.dropdown && setMobileMenuOpen(false)}
                  >
                    <span>{item.label}</span>
                    {item.badge && <Badge className="bg-indigo-600 text-white">{item.badge}</Badge>}
                  </a>
                  {item.dropdown && (
                    <div className="ml-4 space-y-1">
                      {item.dropdown.map((subItem, subIndex) => (
                        <a
                          key={subIndex}
                          href={subItem.href}
                          className="flex items-center gap-2 p-3 text-gray-600 rounded-lg hover:bg-gray-50"
                          onClick={() => setMobileMenuOpen(false)}
                        >
                          <span>{subItem.icon}</span>
                          <span>{subItem.label}</span>
                        </a>
                      ))}
                    </div>
                  )}
                </div>
              ))}
              <Separator className="my-4" />
              <Button
                onClick={() => {
                  setMobileMenuOpen(false);
                  scrollToSection('text-feature');
                }}
                className="w-full bg-gradient-to-r from-indigo-600 to-emerald-500 text-white"
              >
                <Sparkles className="w-4 h-4 mr-2" />
                Get Started Free
              </Button>
            </div>
          </ScrollArea>
        </div>
      )}
    </header>
  );
}

// ==================== HERO SECTION ====================
function HeroSection() {
  const [currentSlide, setCurrentSlide] = useState(0);
  
  const slides = [
    {
      image: '/hero-cat.jpg',
      title: 'Turn Photos into Coloring Pages',
      subtitle: 'Upload any photo and watch AI transform it into a beautiful coloring page in seconds'
    },
    {
      image: '/mermaid-yoga.jpg',
      title: 'Create From Text Descriptions',
      subtitle: 'Simply describe what you want, and our AI will generate unique coloring pages'
    },
    {
      image: '/tortoise-hare-cover.jpg',
      title: 'Build Complete Coloring Books',
      subtitle: 'Generate multi-page coloring books with consistent characters and stories'
    }
  ];

  useEffect(() => {
    const timer = setInterval(() => {
      setCurrentSlide((prev) => (prev + 1) % slides.length);
    }, 5000);
    return () => clearInterval(timer);
  }, [slides.length]);

  return (
    <section className="relative min-h-[90vh] flex items-center overflow-hidden">
      {/* Background Gradient */}
      <div className="absolute inset-0 bg-gradient-to-br from-slate-50 via-indigo-50 to-emerald-50" />
      
      {/* Animated Background Shapes */}
      <div className="absolute inset-0 overflow-hidden">
        <div className="absolute top-16 left-10 w-80 h-80 bg-indigo-300/15 rounded-full blur-3xl animate-pulse" />
        <div className="absolute bottom-16 right-10 w-[28rem] h-[28rem] bg-emerald-300/15 rounded-full blur-3xl animate-pulse delay-1000" />
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[780px] h-[780px] bg-fuchsia-300/10 rounded-full blur-3xl" />
      </div>

      <div className="relative max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-12 lg:py-20">
        <div className="grid lg:grid-cols-2 gap-12 lg:gap-16 items-center">
          {/* Left Content */}
          <div className="space-y-8 text-center lg:text-left">
            <div className="inline-flex items-center gap-2 px-4 py-2 bg-white rounded-full shadow-sm border border-indigo-100">
              <Badge className="bg-gradient-to-r from-indigo-600 to-emerald-500 text-white">Instant Studio</Badge>
              <span className="text-sm text-gray-600">Print-ready outlines, in seconds</span>
            </div>
            
            <h1 className="text-4xl sm:text-5xl lg:text-6xl xl:text-7xl font-bold leading-tight">
              Turn <span className="text-gradient">ideas</span>{' '}
              into <span className="text-gradient-orange">printable</span>{' '}
              <span className="text-indigo-600">coloring pages</span>
            </h1>
            
            <p className="text-lg lg:text-xl text-gray-600 max-w-2xl mx-auto lg:mx-0 leading-relaxed">
              Transform photos and text into stunning coloring pages with AI. Perfect for Amazon KDP, 
              Etsy sellers, teachers, parents, and creative enthusiasts. Create unlimited designs 
              in seconds!
            </p>
            
            <div className="flex flex-col sm:flex-row gap-4 justify-center lg:justify-start">
              <Button
                onClick={() => {
                  scrollToSection('text-feature');
                  window.setTimeout(() => {
                    const input = document.getElementById('text-generator-prompt');
                    if (input instanceof HTMLInputElement) input.focus();
                  }, 250);
                }}
                className="bg-gradient-to-r from-indigo-600 to-emerald-500 hover:from-indigo-700 hover:to-emerald-600 text-white px-8 py-6 text-lg rounded-xl shadow-lg shadow-indigo-600/20 hover:shadow-xl hover:shadow-indigo-600/25 transition-all"
              >
                <Sparkles className="w-5 h-5 mr-2" />
                Start Creating Free
              </Button>
              <Button
                onClick={() => scrollToSection('photo-feature')}
                variant="outline"
                className="px-8 py-6 text-lg rounded-xl border-2 hover:bg-indigo-50"
              >
                <Play className="w-5 h-5 mr-2" />
                Watch Demo
              </Button>
            </div>
            
            <div className="flex flex-wrap gap-4 justify-center lg:justify-start pt-4">
              {[
                { icon: Shield, text: '100% Commercial License' },
                { icon: CreditCard, text: 'No Credit Card Required' },
                { icon: Clock, text: 'Instant Generation' },
              ].map((item, index) => (
                <div key={index} className="flex items-center gap-2 text-gray-600 bg-white/80 px-4 py-2 rounded-full">
                  <item.icon className="w-5 h-5 text-indigo-600" />
                  <span className="text-sm font-medium">{item.text}</span>
                </div>
              ))}
            </div>
          </div>
          
          {/* Right Content - Image Slider */}
          <div className="relative">
            <div className="relative rounded-3xl overflow-hidden shadow-2xl bg-white p-2">
              <div className="relative aspect-[4/5] rounded-2xl overflow-hidden">
                {slides.map((slide, index) => (
                  <div
                    key={index}
                    className={`absolute inset-0 transition-opacity duration-700 ${
                      index === currentSlide ? 'opacity-100' : 'opacity-0'
                    }`}
                  >
                    <img 
                      src={slide.image} 
                      alt={slide.title}
                      className="w-full h-full object-cover"
                    />
                    <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/70 to-transparent p-6">
                      <h3 className="text-white font-bold text-lg">{slide.title}</h3>
                      <p className="text-white/80 text-sm">{slide.subtitle}</p>
                    </div>
                  </div>
                ))}
              </div>
              
              {/* Slider Controls */}
              <div className="absolute bottom-4 left-1/2 -translate-x-1/2 flex gap-2">
                {slides.map((_, index) => (
                  <button
                    key={index}
                    onClick={() => setCurrentSlide(index)}
                    className={`w-2 h-2 rounded-full transition-all ${
                      index === currentSlide ? 'w-8 bg-indigo-600' : 'bg-white/50'
                    }`}
                  />
                ))}
              </div>
            </div>
            
            {/* Floating Stats Cards */}
            <div className="absolute -bottom-6 -left-6 bg-white rounded-xl shadow-xl p-4 border border-gray-100">
              <div className="flex items-center gap-3">
                <div className="w-12 h-12 bg-indigo-100 rounded-lg flex items-center justify-center">
                  <Palette className="w-6 h-6 text-indigo-600" />
                </div>
                <div>
                  <div className="text-2xl font-bold text-gray-900">2.4M+</div>
                  <div className="text-sm text-gray-500">Pages Generated</div>
                </div>
              </div>
            </div>
            
            <div className="absolute -top-6 -right-6 bg-white rounded-xl shadow-xl p-4 border border-gray-100">
              <div className="flex items-center gap-3">
                <div className="w-12 h-12 bg-emerald-100 rounded-lg flex items-center justify-center">
                  <Users className="w-6 h-6 text-emerald-600" />
                </div>
                <div>
                  <div className="text-2xl font-bold text-gray-900">320K+</div>
                  <div className="text-sm text-gray-500">Happy Users</div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

// ==================== HOW IT WORKS ====================
function HowItWorksSection() {
  const steps = [
    {
      number: '01',
      title: 'Choose Your Method',
      description: 'Select from Photo-to-Coloring, Text-to-Coloring, or Coloring Book Generator based on your needs.',
      icon: Layers,
      color: 'from-indigo-500 to-indigo-600'
    },
    {
      number: '02',
      title: 'Upload or Describe',
      description: 'Upload your photo or type a detailed description of what you want to create.',
      icon: Upload,
      color: 'from-emerald-400 to-emerald-500'
    },
    {
      number: '03',
      title: 'AI Magic Happens',
      description: 'Our advanced AI processes your input and generates beautiful coloring pages in seconds.',
      icon: Wand2,
      color: 'from-fuchsia-500 to-fuchsia-600'
    },
    {
      number: '04',
      title: 'Download & Print',
      description: 'Get high-resolution PDF/PNG files ready for printing or digital coloring.',
      icon: Download,
      color: 'from-sky-500 to-sky-600'
    }
  ];

  return (
    <section className="py-20 bg-white">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="text-center mb-16">
          <Badge className="bg-indigo-100 text-indigo-700 mb-4">Simple Process</Badge>
          <h2 className="text-3xl lg:text-5xl font-bold text-gray-900 mb-4">How It Works</h2>
          <p className="text-lg text-gray-600 max-w-2xl mx-auto">
            Create stunning coloring pages in just 4 simple steps. No design skills required!
          </p>
        </div>
        
        <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-8">
          {steps.map((step, index) => (
            <div key={index} className="relative group">
              <div className="bg-gray-50 rounded-2xl p-8 h-full hover:bg-white hover:shadow-xl transition-all duration-300 border border-transparent hover:border-indigo-100">
                <div className={`w-16 h-16 rounded-2xl bg-gradient-to-br ${step.color} flex items-center justify-center mb-6 group-hover:scale-110 transition-transform`}>
                  <step.icon className="w-8 h-8 text-white" />
                </div>
                <div className="text-5xl font-bold text-gray-200 mb-4">{step.number}</div>
                <h3 className="text-xl font-bold text-gray-900 mb-3">{step.title}</h3>
                <p className="text-gray-600 leading-relaxed">{step.description}</p>
              </div>
              {index < steps.length - 1 && (
                <div className="hidden lg:block absolute top-1/2 -right-4 transform -translate-y-1/2 z-10">
                  <ArrowRight className="w-8 h-8 text-indigo-200" />
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

// ==================== FEATURES GRID ====================
function FeaturesGridSection() {
  const features = [
    {
      icon: ImageIcon,
      title: 'Photo to Coloring Page',
      description: 'Transform any photo into a beautiful coloring page. Perfect for pet portraits, family photos, and favorite memories.',
      color: 'bg-indigo-100 text-indigo-700',
      href: '#photo-feature'
    },
    {
      icon: Type,
      title: 'Text to Coloring Page',
      description: 'Describe anything and watch AI create it. From unicorns to spaceships, if you can imagine it, we can draw it.',
      color: 'bg-emerald-100 text-emerald-700',
      href: '#text-feature'
    },
    {
      icon: BookOpen,
      title: 'Coloring Book Generator',
      description: 'Create complete coloring books with consistent characters and flowing stories. Perfect for Amazon KDP publishing.',
      color: 'bg-purple-100 text-purple-600',
      href: '#book-feature',
      badge: 'New'
    },
    {
      icon: Paintbrush,
      title: 'Colorize Drawings',
      description: 'Add vibrant colors to your black-and-white drawings with AI. Multiple artistic styles available.',
      color: 'bg-sky-100 text-sky-700',
      href: '#colorize-feature'
    },
    {
      icon: ScanLine,
      title: 'Line Art Converter',
      description: 'Convert any image to clean line art perfect for coloring. Adjust thickness and detail levels.',
      color: 'bg-green-100 text-green-600',
      href: '#'
    },
    {
      icon: PenTool,
      title: 'Online Coloring Tool',
      description: 'Color your pages directly in the browser. Save progress, try different palettes, and share your creations.',
      color: 'bg-yellow-100 text-yellow-600',
      href: '#online-coloring'
    }
  ];

  return (
    <section className="py-20 bg-gray-50">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="text-center mb-16">
          <Badge className="bg-indigo-100 text-indigo-700 mb-4">Powerful Tools</Badge>
          <h2 className="text-3xl lg:text-5xl font-bold text-gray-900 mb-4">Everything You Need</h2>
          <p className="text-lg text-gray-600 max-w-2xl mx-auto">
            Six powerful AI tools to create, customize, and color your perfect coloring pages
          </p>
        </div>
        
        <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
          {features.map((feature, index) => (
            <a 
              key={index} 
              href={feature.href}
              className="group bg-white rounded-2xl p-8 hover:shadow-xl transition-all duration-300 border border-gray-100 hover:border-indigo-200"
            >
              <div className={`w-16 h-16 ${feature.color} rounded-2xl flex items-center justify-center mb-6 group-hover:scale-110 transition-transform`}>
                <feature.icon className="w-8 h-8" />
              </div>
              <div className="flex items-center gap-2 mb-3">
                <h3 className="text-xl font-bold text-gray-900">{feature.title}</h3>
                {feature.badge && (
                  <Badge className="bg-gradient-to-r from-indigo-600 to-emerald-500 text-white text-xs">
                    {feature.badge}
                  </Badge>
                )}
              </div>
              <p className="text-gray-600 leading-relaxed mb-4">{feature.description}</p>
              <div className="flex items-center text-indigo-600 font-medium group-hover:gap-2 transition-all">
                <span>Learn More</span>
                <ArrowRight className="w-4 h-4 ml-1 group-hover:translate-x-1 transition-transform" />
              </div>
            </a>
          ))}
        </div>
      </div>
    </section>
  );
}

// ==================== PHOTO TO COLORING FEATURE ====================
function PhotoToColoringSection() {
  const [photoFile, setPhotoFile] = useState<File | null>(null);
  const [photoPreviewUrl, setPhotoPreviewUrl] = useState<string | null>(null);
  const [isConverting, setIsConverting] = useState(false);
  const [resultUrl, setResultUrl] = useState<string | null>(null);
  const [coloredUrl, setColoredUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastAutoConvertedId, setLastAutoConvertedId] = useState<string | null>(null);

  useEffect(() => {
    if (!photoFile) {
      setPhotoPreviewUrl((prev) => {
        if (prev?.startsWith('blob:')) URL.revokeObjectURL(prev);
        return null;
      });
      return;
    }

    const url = URL.createObjectURL(photoFile);
    setPhotoPreviewUrl((prev) => {
      if (prev?.startsWith('blob:')) URL.revokeObjectURL(prev);
      return url;
    });

    return () => URL.revokeObjectURL(url);
  }, [photoFile]);

  useEffect(() => {
    return () => {
      if (resultUrl?.startsWith('blob:')) URL.revokeObjectURL(resultUrl);
    };
  }, [resultUrl]);

  useEffect(() => {
    return () => {
      if (coloredUrl?.startsWith('blob:')) URL.revokeObjectURL(coloredUrl);
    };
  }, [coloredUrl]);

  const handleConvert = useCallback(async (fileOverride?: File) => {
    const file = fileOverride ?? photoFile
    if (!file) {
      setError('Please choose a photo first.')
      return
    }

    setError(null)
    setIsConverting(true)

    const controller = new AbortController()
    const timeout = window.setTimeout(() => controller.abort(), 120_000)

    try {
      const publicUrl = await uploadToPollinations(file, controller.signal)
      const seed = makePollinationsSeed()

      const bwPrompt =
        'Convert this photo into a clean black and white coloring page with bold outlines, no shading, no colors, suitable for kids to color in'
      const colorPrompt =
        'Colorize this black and white photograph with highly realistic and vivid natural colors, preserve all original details, textures and lighting'

      const bwUrl = buildPollinationsImageUrl(bwPrompt, {
        image: publicUrl,
        model: 'kontext',
        nologo: true,
        width: 1024,
        height: 1024,
        seed,
      })
      const colorUrl = buildPollinationsImageUrl(colorPrompt, {
        image: publicUrl,
        model: 'kontext',
        nologo: true,
        width: 1024,
        height: 1024,
        seed,
      })

      setResultUrl(bwUrl)
      setColoredUrl(colorUrl)

      await Promise.all([preloadImage(bwUrl), preloadImage(colorUrl)])
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Conversion failed')
    } finally {
      window.clearTimeout(timeout)
      setIsConverting(false)
    }
  }, [photoFile]);

  useEffect(() => {
    if (!photoFile) return;
    if (isConverting) return;
    const id = `${photoFile.name}:${photoFile.size}:${photoFile.lastModified}`;
    if (id === lastAutoConvertedId) return;
    setLastAutoConvertedId(id);
    void handleConvert(photoFile);
  }, [photoFile, isConverting, lastAutoConvertedId, handleConvert]);

  return (
    <section id="photo-feature" className="py-20 bg-white">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="grid lg:grid-cols-2 gap-16 items-center">
          <div className="order-2 lg:order-1 space-y-8">
            <div>
              <Badge className="bg-indigo-100 text-indigo-700 mb-4">Photo Conversion</Badge>
              <h2 className="text-3xl lg:text-5xl font-bold text-gray-900 mb-4">
                Turn Photos into <span className="text-gradient">Coloring Pages</span>
              </h2>
              <p className="text-lg text-gray-600 leading-relaxed">
                Upload any photo and our AI will transform it into a beautiful, print-ready coloring page. 
                Perfect for creating personalized gifts, keepsakes, or products to sell.
              </p>
            </div>
            
            <div className="grid sm:grid-cols-2 gap-4">
              {[
                { icon: ImageIcon, title: 'Pet Portraits', desc: 'Turn pet photos into coloring pages' },
                { icon: Users, title: 'Family Photos', desc: 'Create family coloring memories' },
                { icon: Heart, title: 'Favorite Things', desc: 'Any object or scene you love' },
                { icon: Zap, title: 'Instant Results', desc: 'Get your page in seconds' },
              ].map((item, index) => (
                <div key={index} className="flex items-start gap-3 p-4 bg-gray-50 rounded-xl">
                  <div className="w-10 h-10 bg-indigo-100 rounded-lg flex items-center justify-center flex-shrink-0">
                    <item.icon className="w-5 h-5 text-indigo-600" />
                  </div>
                  <div>
                    <h4 className="font-semibold text-gray-900">{item.title}</h4>
                    <p className="text-sm text-gray-500">{item.desc}</p>
                  </div>
                </div>
              ))}
            </div>

            <div className="space-y-3">
              <Input
                type="file"
                accept="image/*"
                onChange={(e) => setPhotoFile(e.target.files?.[0] ?? null)}
              />

              <Button
                onClick={() => handleConvert()}
                disabled={isConverting || !photoFile}
                className="bg-gradient-to-r from-indigo-600 to-emerald-500 hover:from-indigo-700 hover:to-emerald-600 text-white px-8 py-6 text-lg rounded-xl"
              >
                <Upload className="w-5 h-5 mr-2" />
                {isConverting ? 'Generating...' : 'Generate Results'}
              </Button>

              {resultUrl && (
                <Button variant="outline" className="w-full" onClick={() => openOnlineColoring(resultUrl)}>
                  Color This Online
                </Button>
              )}

              {error && <div className="text-sm text-red-600">{error}</div>}
            </div>
          </div>
          
          <div className="order-1 lg:order-2">
            <div className="relative">
              {photoPreviewUrl && (resultUrl || coloredUrl) ? (
                <div className={`grid gap-4 ${coloredUrl && resultUrl ? 'grid-cols-3' : 'grid-cols-2'}`}>
                  <div className="bg-white rounded-2xl shadow-lg p-3">
                    <img
                      src={photoPreviewUrl}
                      alt="Original"
                      className="rounded-xl w-full h-64 object-cover"
                    />
                    <p className="text-center text-sm text-gray-500 mt-2">Original Photo</p>
                  </div>
                  {resultUrl && (
                    <div className="bg-white rounded-2xl shadow-lg p-3">
                      <img
                        src={resultUrl}
                        alt="Generated coloring page"
                        crossOrigin="anonymous"
                        onError={() => setError('Generation failed, please try again')}
                        className="rounded-xl w-full h-64 object-contain bg-gray-50"
                      />
                      <p className="text-center text-sm text-gray-500 mt-2">Coloring Page</p>
                    </div>
                  )}
                  {coloredUrl && (
                    <div className="bg-white rounded-2xl shadow-lg p-3">
                      <img
                        src={coloredUrl}
                        alt="Auto-colored preview"
                        crossOrigin="anonymous"
                        onError={() => setError('Generation failed, please try again')}
                        className="rounded-xl w-full h-64 object-cover"
                      />
                      <p className="text-center text-sm text-gray-500 mt-2">Auto Color</p>
                    </div>
                  )}
                </div>
              ) : (
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-4">
                    <div className="bg-white rounded-2xl shadow-lg p-3">
                      <img src="/ice-cream.jpg" alt="Original" className="rounded-xl w-full h-40 object-cover" />
                      <p className="text-center text-sm text-gray-500 mt-2">Original Photo</p>
                    </div>
                    <div className="bg-white rounded-2xl shadow-lg p-3">
                      <img src="/hero-cat.jpg" alt="Result" className="rounded-xl w-full h-48 object-cover" />
                      <p className="text-center text-sm text-gray-500 mt-2">Coloring Page</p>
                    </div>
                  </div>
                  <div className="space-y-4 pt-8">
                    <div className="bg-white rounded-2xl shadow-lg p-3">
                      <img src="/dino.jpg" alt="Result" className="rounded-xl w-full h-48 object-cover" />
                      <p className="text-center text-sm text-gray-500 mt-2">Cute Dinosaur</p>
                    </div>
                    <div className="bg-white rounded-2xl shadow-lg p-3">
                      <img src="/rabbit-lake.jpg" alt="Result" className="rounded-xl w-full h-40 object-cover" />
                      <p className="text-center text-sm text-gray-500 mt-2">Rabbit Scene</p>
                    </div>
                  </div>
                </div>
              )}
              
              {/* Floating Badge */}
              <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 bg-white rounded-full p-4 shadow-xl">
                <div className="w-16 h-16 bg-gradient-to-r from-indigo-600 to-emerald-500 rounded-full flex items-center justify-center">
                  <Wand2 className="w-8 h-8 text-white" />
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

// ==================== TEXT TO COLORING FEATURE ====================
function TextToColoringSection() {
  const [prompt, setPrompt] = useState('');
  const [isGenerating, setIsGenerating] = useState(false);
  const [generatedImageUrl, setGeneratedImageUrl] = useState<string | null>(null);
  const [generateError, setGenerateError] = useState<string | null>(null);

  const examples = [
    { prompt: 'A cute mermaid doing yoga underwater', image: '/mermaid-yoga.jpg' },
    { prompt: 'A magical princess in a castle garden', image: '/princess.jpg' },
    { prompt: 'A friendly dragon breathing heart-shaped fire', image: '/dragon.jpg' },
  ];

  useEffect(() => {
    return () => {
      if (generatedImageUrl?.startsWith('blob:')) URL.revokeObjectURL(generatedImageUrl);
    };
  }, [generatedImageUrl]);

  const handleGenerate = async () => {
    const effectivePrompt = (prompt || 'A cute astronaut cat on the moon').trim();
    if (!effectivePrompt) return;

    setGenerateError(null);
    setIsGenerating(true);

    try {
      const coloringPrompt = `Coloring book page line art. Black and white. Clean bold outlines. No shading. No gray. White background. Centered subject. ${effectivePrompt}`
      const seed = makePollinationsSeed()
      const url = buildPollinationsImageUrl(coloringPrompt, {
        model: 'flux',
        seed,
        nologo: true,
        width: 1024,
        height: 1024,
      })
      setGeneratedImageUrl(url)
      await preloadImage(url)
    } catch (err) {
      setGenerateError(err instanceof Error ? err.message : 'Generation failed');
    } finally {
      setIsGenerating(false);
    }
  };

  return (
    <section id="text-feature" className="py-20 bg-gradient-to-br from-slate-50 via-indigo-50 to-emerald-50">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="text-center mb-16">
          <Badge className="bg-indigo-100 text-indigo-700 mb-4">Text-to-Image</Badge>
          <h2 className="text-3xl lg:text-5xl font-bold text-gray-900 mb-4">
            Describe It, <span className="text-gradient">We Draw It</span>
          </h2>
          <p className="text-lg text-gray-600 max-w-2xl mx-auto">
            Simply type what you want to see, and our AI will create a unique coloring page. 
            From simple descriptions to complex scenes.
          </p>
        </div>
        
        {/* Demo Input */}
        <div className="max-w-2xl mx-auto mb-16">
          <div className="bg-white rounded-2xl shadow-xl p-2">
            <div className="flex gap-2">
              <div className="flex-1 relative">
                <MessageSquare className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400" />
                <Input 
                  id="text-generator-prompt"
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  placeholder="Describe your coloring page... (e.g., 'A cute unicorn in a rainbow forest')"
                  className="pl-12 h-14 border-0 text-lg"
                />
              </div>
              <Button
                onClick={handleGenerate}
                disabled={isGenerating}
                className="bg-gradient-to-r from-indigo-600 to-emerald-500 hover:from-indigo-700 hover:to-emerald-600 text-white px-6 h-14"
              >
                <Sparkles className="w-5 h-5 mr-2" />
                {isGenerating ? 'Generating...' : 'Generate'}
              </Button>
            </div>
          </div>
          <p className="text-center text-sm text-gray-500 mt-4">
            Try: "A cute astronaut cat on the moon" or "A magical fairy garden"
          </p>

          {generateError && (
            <div className="mt-4 text-center text-sm text-red-600">
              {generateError}
            </div>
          )}

          {generatedImageUrl && (
            <div className="mt-6 bg-white rounded-2xl shadow-xl p-3">
              <img
                src={generatedImageUrl}
                alt="Generated preview"
                crossOrigin="anonymous"
                onError={() => setGenerateError('Generation failed, please try again')}
                className="rounded-xl w-full max-h-[520px] object-contain bg-gray-50"
              />
              <div className="mt-3">
                <Button
                  variant="outline"
                  className="w-full"
                  onClick={() => openOnlineColoring(generatedImageUrl)}
                >
                  Color This Online
                </Button>
              </div>
            </div>
          )}
        </div>
        
        {/* Examples */}
        <div className="grid md:grid-cols-3 gap-8">
          {examples.map((example, index) => (
            <div key={index} className="group">
              <div className="bg-white rounded-2xl overflow-hidden shadow-lg hover:shadow-xl transition-shadow">
                <div className="aspect-square overflow-hidden">
                  <img 
                    src={example.image} 
                    alt={example.prompt}
                    className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500"
                  />
                </div>
                <div className="p-4">
                  <p className="text-sm text-gray-500 mb-2">Prompt:</p>
                  <p className="text-gray-900 font-medium">"{example.prompt}"</p>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

// ==================== COLORING BOOK GENERATOR ====================
function ColoringBookSection() {
  const [theme, setTheme] = useState('');
  const [character, setCharacter] = useState('');
  const [pageNumber, setPageNumber] = useState(1);
  const [pageCount, setPageCount] = useState(6);
  const [isGenerating, setIsGenerating] = useState(false);
  const [view, setView] = useState<'cover' | 'page'>('cover');
  const [coverUrl, setCoverUrl] = useState<string | null>(null);
  const [pageUrls, setPageUrls] = useState<Record<number, string>>({});
  const [error, setError] = useState<string | null>(null);

  const generateImage = async (kind: 'cover' | 'page') => {
    const t = (theme || 'A magical forest adventure').trim();
    const c = (character || 'A cute explorer bunny').trim();
    if (!t || !c) return;

    setError(null);
    setIsGenerating(true);

    try {
      const baseStyle =
        'Coloring book line art. Black and white. Clean bold outlines. No shading. No gray. White background.'
      const prompt =
        kind === 'cover'
          ? `${baseStyle} Coloring book cover. Large centered title area. Theme: ${t}. Main character: ${c}.`
          : `${baseStyle} Interior coloring page. Theme: ${t}. Main character: ${c}. Page ${pageNumber}.`
      const seed = makePollinationsSeed()
      const url = buildPollinationsImageUrl(prompt, {
        model: 'flux',
        seed,
        nologo: true,
        width: 1024,
        height: 1024,
      })
      await preloadImage(url)

      if (kind === 'cover') {
        setCoverUrl((prev) => {
          if (prev?.startsWith('blob:')) URL.revokeObjectURL(prev)
          return url
        })
        setView('cover')
      } else {
        setPageUrls((prev) => {
          const existing = prev[pageNumber]
          if (existing?.startsWith('blob:')) URL.revokeObjectURL(existing)
          return { ...prev, [pageNumber]: url }
        })
        setView('page')
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Generation failed');
    } finally {
      setIsGenerating(false);
    }
  };

  const clampedPageCount = Math.max(1, Math.min(200, Number.isFinite(pageCount) ? pageCount : 6));
  const clampedPageNumber = Math.max(1, Math.min(clampedPageCount, Number.isFinite(pageNumber) ? pageNumber : 1));
  const displayedUrl =
    view === 'cover'
      ? coverUrl ?? '/tortoise-hare-cover.jpg'
      : pageUrls[clampedPageNumber] ?? '/hero-cat.jpg';

  return (
    <section id="book-feature" className="py-20 bg-white">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="grid lg:grid-cols-2 gap-16 items-center">
          <div className="relative">
            <div className="bg-gradient-to-br from-indigo-100 to-emerald-100 rounded-3xl p-8">
              <img 
                src={displayedUrl} 
                alt={view === 'cover' ? 'Coloring Book Cover' : `Coloring Book Page ${clampedPageNumber}`} 
                className="rounded-2xl shadow-2xl w-full max-w-md mx-auto bg-white"
              />
              <div className="mt-4">
                <Button
                  variant="outline"
                  className="w-full"
                  onClick={() => openOnlineColoring(displayedUrl)}
                >
                  Color This Online
                </Button>
              </div>
              <div className="mt-6 bg-white/80 backdrop-blur rounded-xl p-4">
                <div className="flex justify-between items-center mb-4">
                  <span className="text-sm text-gray-500">
                    {(theme || 'The Tortoise and the Hare Race').trim()}
                  </span>
                  <Badge className="bg-indigo-600 text-white">{clampedPageCount} Pages</Badge>
                </div>
                <div className="flex gap-2">
                  {Array.from({ length: clampedPageCount }, (_, i) => i + 1).slice(0, 12).map((page) => (
                    <div
                      key={page}
                      className={`flex-1 h-2 rounded-full ${
                        view === 'page' && page <= clampedPageNumber ? 'bg-indigo-600' : 'bg-gray-200'
                      }`}
                    />
                  ))}
                </div>
                <div className="flex justify-between mt-4">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={clampedPageNumber <= 1}
                    onClick={() => {
                      setView('page');
                      setPageNumber((p) => Math.max(1, p - 1));
                    }}
                  >
                    Previous
                  </Button>
                  <span className="text-sm text-gray-500 self-center">
                    {view === 'cover' ? 'Cover' : `Page ${clampedPageNumber} of ${clampedPageCount}`}
                  </span>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={clampedPageNumber >= clampedPageCount}
                    onClick={() => {
                      setView('page');
                      setPageNumber((p) => Math.min(clampedPageCount, p + 1));
                    }}
                  >
                    Next
                  </Button>
                </div>
              </div>
            </div>
            
            {/* Stats Overlay */}
            <div className="absolute -bottom-4 -right-4 bg-white rounded-xl shadow-xl p-4 border border-gray-100">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 bg-green-100 rounded-lg flex items-center justify-center">
                  <BookOpen className="w-5 h-5 text-green-500" />
                </div>
                <div>
                  <div className="text-lg font-bold text-gray-900">200 Pages</div>
                  <div className="text-xs text-gray-500">Max per book</div>
                </div>
              </div>
            </div>
          </div>
          
          <div className="space-y-8">
            <div>
              <Badge className="bg-gradient-to-r from-indigo-600 to-emerald-500 text-white mb-4">New Feature</Badge>
              <h2 className="text-3xl lg:text-5xl font-bold text-gray-900 mb-4">
                AI Multi-Page <span className="text-gradient">Coloring Book</span> Generator
              </h2>
              <p className="text-lg text-gray-600 leading-relaxed">
                Create complete coloring books with consistent characters and flowing stories. 
                Perfect for Amazon KDP publishing, Etsy shops, or personal collections.
              </p>
            </div>
            
            <div className="space-y-4">
              {[
                { title: 'Consistent Characters', desc: 'Same character appearance across all pages' },
                { title: 'Flowing Storylines', desc: 'AI creates coherent narratives throughout the book' },
                { title: 'Print-Ready Output', desc: 'High-resolution PDFs optimized for printing' },
                { title: 'One-Click Generation', desc: 'Generate up to 200 pages with a single prompt' },
              ].map((feature, index) => (
                <div key={index} className="flex items-start gap-4 p-4 bg-gray-50 rounded-xl">
                  <div className="w-8 h-8 bg-indigo-600 rounded-full flex items-center justify-center flex-shrink-0">
                    <Check className="w-4 h-4 text-white" />
                  </div>
                  <div>
                    <h4 className="font-semibold text-gray-900">{feature.title}</h4>
                    <p className="text-gray-500">{feature.desc}</p>
                  </div>
                </div>
              ))}
            </div>
            
            <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-4 space-y-3">
              <Input
                value={theme}
                onChange={(e) => setTheme(e.target.value)}
                placeholder="Book theme (e.g., 'Space adventure')"
              />
              <Input
                value={character}
                onChange={(e) => setCharacter(e.target.value)}
                placeholder="Main character (e.g., 'Astronaut cat')"
              />
              <div className="flex gap-2">
                <Input
                  type="number"
                  min={1}
                  max={200}
                  value={clampedPageCount}
                  onChange={(e) => setPageCount(Number(e.target.value || 6))}
                />
                <Button
                  variant="outline"
                  className="whitespace-nowrap"
                  onClick={() => setView('cover')}
                >
                  View Cover
                </Button>
              </div>
              <div className="flex gap-2">
                <Input
                  type="number"
                  min={1}
                  max={clampedPageCount}
                  value={clampedPageNumber}
                  onChange={(e) => {
                    setView('page');
                    setPageNumber(Number(e.target.value || 1));
                  }}
                />
                <Button
                  variant="outline"
                  className="whitespace-nowrap"
                  onClick={() => generateImage('page')}
                  disabled={isGenerating}
                >
                  {isGenerating ? 'Generating...' : 'Generate Page'}
                </Button>
              </div>
              <Button
                className="w-full bg-gradient-to-r from-indigo-600 to-emerald-500 hover:from-indigo-700 hover:to-emerald-600 text-white"
                onClick={() => generateImage('cover')}
                disabled={isGenerating}
              >
                <BookOpen className="w-5 h-5 mr-2" />
                {isGenerating ? 'Generating...' : 'Generate Cover'}
              </Button>
              {error && <div className="text-sm text-red-600">{error}</div>}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

function ImageEditorSection() {
  type EditMode = 'colorize' | 'enhance' | 'background' | 'style' | 'custom'
  type StyleOption = 'Anime' | 'Oil Painting' | 'Watercolor' | 'Pixel Art' | 'Sketch' | 'Pop Art'
  type ModelOption = 'kontext' | 'gptimage' | 'seedream'
  type HistoryItem = {
    id: string
    createdAt: number
    mode: EditMode
    model: ModelOption
    seed: string
    uploadedUrl: string
    prompt: string
    label: string
  }

  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const [isDragging, setIsDragging] = useState(false)
  const [file, setFile] = useState<File | null>(null)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [uploadedUrl, setUploadedUrl] = useState<string | null>(null)
  const [mode, setMode] = useState<EditMode>('colorize')
  const [model, setModel] = useState<ModelOption>('kontext')
  const [style, setStyle] = useState<StyleOption>('Anime')
  const [customPrompt, setCustomPrompt] = useState('')
  const [isWorking, setIsWorking] = useState(false)
  const [progressText, setProgressText] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [resultUrl, setResultUrl] = useState<string | null>(null)
  const [compare, setCompare] = useState(50)
  const [history, setHistory] = useState<HistoryItem[]>(() => {
    try {
      const raw = localStorage.getItem('INKBLOOM_EDIT_HISTORY')
      if (!raw) return []
      const data = JSON.parse(raw) as unknown
      if (!Array.isArray(data)) return []
      return data
        .filter((x) => x && typeof x === 'object')
        .slice(0, 10) as HistoryItem[]
    } catch {
      return []
    }
  })

  useEffect(() => {
    if (!file) {
      setPreviewUrl((prev) => {
        if (prev?.startsWith('blob:')) URL.revokeObjectURL(prev)
        return null
      })
      setUploadedUrl(null)
      return
    }

    const url = URL.createObjectURL(file)
    setPreviewUrl((prev) => {
      if (prev?.startsWith('blob:')) URL.revokeObjectURL(prev)
      return url
    })
    return () => URL.revokeObjectURL(url)
  }, [file])

  useEffect(() => {
    try {
      localStorage.setItem('INKBLOOM_EDIT_HISTORY', JSON.stringify(history.slice(0, 10)))
    } catch {
      return
    }
  }, [history])

  useEffect(() => {
    return () => {
      if (resultUrl?.startsWith('blob:')) URL.revokeObjectURL(resultUrl)
    }
  }, [resultUrl])

  const handleFileSelect = (selected: File) => {
    if (!selected.type.startsWith('image/')) {
      setError('Please upload an image (JPG, PNG, WEBP).')
      return
    }
    if (selected.size > 10 * 1024 * 1024) {
      setError('File too large. Max 10MB.')
      return
    }
    setError(null)
    setFile(selected)
    setUploadedUrl(null)
    setResultUrl((prev) => {
      if (prev?.startsWith('blob:')) URL.revokeObjectURL(prev)
      return null
    })
  }

  const buildPrompt = () => {
    const base =
      'Apply the edit to the uploaded image. Keep the same composition and subject. No text. No watermark.'
    if (mode === 'colorize') {
      return `Colorize this black and white photograph with highly realistic and vivid natural colors, preserve all original details, textures and lighting. ${base}`
    }
    if (mode === 'enhance') {
      return `Enhance this image, improve quality, sharpen details, fix lighting and colors, make it look professional. ${base}`
    }
    if (mode === 'background') {
      return `Remove the background and replace it with a clean white background. ${base}`
    }
    if (mode === 'style') {
      const styleMap: Record<StyleOption, string> = {
        Anime: 'anime illustration',
        'Oil Painting': 'oil painting',
        Watercolor: 'watercolor',
        'Pixel Art': 'pixel art',
        Sketch: 'pencil sketch',
        'Pop Art': 'pop art',
      }
      return `Stylize this image into a ${styleMap[style]} style while preserving the original composition and subject. ${base}`
    }
    const trimmed = customPrompt.trim()
    if (!trimmed) return `Enhance this image, improve quality, sharpen details, fix lighting and colors, make it look professional. ${base}`
    return `${trimmed}. ${base}`
  }

  const uploadIfNeeded = async (targetFile: File, controller: AbortController) => {
    if (uploadedUrl) return uploadedUrl
    setProgressText('Uploading image...')
    const url = await uploadToPollinations(targetFile, controller.signal)
    setUploadedUrl(url)
    return url
  }

  const runEdit = async (override?: Partial<Pick<HistoryItem, 'uploadedUrl' | 'seed' | 'model' | 'prompt' | 'label'>>) => {
    if (!file && !override?.uploadedUrl) {
      setError('Please upload an image first.')
      return
    }

    setError(null)
    setIsWorking(true)

    const controller = new AbortController()
    const timeout = window.setTimeout(() => controller.abort(), 120_000)
    const started = Date.now()
    const tick = window.setInterval(() => {
      const seconds = Math.max(0, Math.floor((Date.now() - started) / 1000))
      setProgressText((prev) => (prev ? `${prev} (${seconds}s)` : `Working... (${seconds}s)`))
    }, 1000)

    try {
      const effectiveSeed = override?.seed ?? makePollinationsSeed()
      const effectiveModel = override?.model ?? model
      const promptText = override?.prompt ?? buildPrompt()
      const label = override?.label ?? mode

      setProgressText('Preparing request...')
      const imageUrl = override?.uploadedUrl ?? (file ? await uploadIfNeeded(file, controller) : null)
      if (!imageUrl) throw new Error('Missing image url')

      setProgressText('Generating result...')
      const outUrl = buildPollinationsImageUrl(promptText, {
        image: imageUrl,
        model: effectiveModel,
        width: 1024,
        height: 1024,
        seed: effectiveSeed,
        nologo: true,
      })
      setResultUrl(outUrl)
      await preloadImage(outUrl)

      const item: HistoryItem = {
        id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
        createdAt: Date.now(),
        mode,
        model: effectiveModel,
        seed: effectiveSeed,
        uploadedUrl: imageUrl,
        prompt: promptText,
        label,
      }
      setHistory((prev) => [item, ...prev].slice(0, 10))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Edit failed')
    } finally {
      window.clearTimeout(timeout)
      window.clearInterval(tick)
      setProgressText(null)
      setIsWorking(false)
    }
  }

  const handleDownload = () => {
    if (!resultUrl) return
    fetch(resultUrl)
      .then((res) => res.blob())
      .then((blob) => {
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = 'edited.png'
        a.click()
        window.setTimeout(() => URL.revokeObjectURL(url), 10_000)
      })
      .catch(() => {
        window.open(resultUrl, '_blank', 'noopener,noreferrer')
      })
  }

  return (
    <section id="edit-feature" className="py-20 bg-slate-950 text-white">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="grid lg:grid-cols-2 gap-12 items-start">
          <div className="space-y-6">
            <Badge className="bg-indigo-500/20 text-indigo-200 border border-indigo-500/30">AI Image Editing</Badge>
            <h2 className="text-3xl lg:text-5xl font-bold">
              Edit Photos with <span className="text-transparent bg-clip-text bg-gradient-to-r from-violet-400 to-emerald-300">AI</span>
            </h2>
            <p className="text-slate-300 leading-relaxed">
              Upload an image, choose an edit, pick a model, and generate a high-quality result. Includes before/after comparison, download, and history.
            </p>

            <div className="grid sm:grid-cols-2 gap-3">
              <div className="bg-white/5 border border-white/10 rounded-xl p-4">
                <div className="font-semibold">kontext</div>
                <div className="text-sm text-slate-300">Fast</div>
              </div>
              <div className="bg-white/5 border border-white/10 rounded-xl p-4">
                <div className="font-semibold">gptimage</div>
                <div className="text-sm text-slate-300">High quality</div>
              </div>
            </div>

            <input
              ref={fileInputRef}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0]
                if (f) handleFileSelect(f)
              }}
            />

            <div
              role="button"
              tabIndex={0}
              className={`rounded-xl border-2 border-dashed p-5 transition-colors ${isDragging ? 'border-violet-400 bg-white/5' : 'border-white/15 hover:border-violet-400/70'}`}
              onClick={() => fileInputRef.current?.click()}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') fileInputRef.current?.click()
              }}
              onDragEnter={(e) => {
                e.preventDefault()
                setIsDragging(true)
              }}
              onDragOver={(e) => {
                e.preventDefault()
                setIsDragging(true)
              }}
              onDragLeave={(e) => {
                e.preventDefault()
                setIsDragging(false)
              }}
              onDrop={(e) => {
                e.preventDefault()
                setIsDragging(false)
                const f = e.dataTransfer.files?.[0]
                if (f) handleFileSelect(f)
              }}
            >
              <div className="flex items-center gap-3">
                <Upload className="w-5 h-5 text-violet-300" />
                <div className="flex-1">
                  <div className="font-medium">{file ? file.name : 'Drag & drop or click to upload'}</div>
                  <div className="text-sm text-slate-400">JPG, PNG, WEBP up to 10MB</div>
                </div>
                {file && (
                  <Button
                    type="button"
                    variant="outline"
                    className="border-white/20 text-white hover:bg-white/10"
                    onClick={(e) => {
                      e.stopPropagation()
                      setFile(null)
                      setUploadedUrl(null)
                      setResultUrl((prev) => {
                        if (prev?.startsWith('blob:')) URL.revokeObjectURL(prev)
                        return null
                      })
                    }}
                  >
                    <X className="w-4 h-4" />
                  </Button>
                )}
              </div>
            </div>

            <div className="grid sm:grid-cols-2 gap-3">
              <div className="bg-white/5 border border-white/10 rounded-xl p-4">
                <div className="text-sm text-slate-300 mb-2">Edit</div>
                <select
                  className="w-full bg-slate-900 border border-white/10 rounded-lg px-3 py-2"
                  value={mode}
                  onChange={(e) => setMode(e.target.value as EditMode)}
                >
                  <option value="colorize">Colorize</option>
                  <option value="enhance">Enhance</option>
                  <option value="background">Background Remove</option>
                  <option value="style">Style Transfer</option>
                  <option value="custom">Custom Edit</option>
                </select>
              </div>
              <div className="bg-white/5 border border-white/10 rounded-xl p-4">
                <div className="text-sm text-slate-300 mb-2">Model</div>
                <select
                  className="w-full bg-slate-900 border border-white/10 rounded-lg px-3 py-2"
                  value={model}
                  onChange={(e) => setModel(e.target.value as ModelOption)}
                >
                  <option value="kontext">kontext (fast)</option>
                  <option value="gptimage">gptimage (high quality)</option>
                  <option value="seedream">seedream (creative)</option>
                </select>
              </div>
            </div>

            {mode === 'style' && (
              <div className="bg-white/5 border border-white/10 rounded-xl p-4">
                <div className="text-sm text-slate-300 mb-2">Style</div>
                <select
                  className="w-full bg-slate-900 border border-white/10 rounded-lg px-3 py-2"
                  value={style}
                  onChange={(e) => setStyle(e.target.value as StyleOption)}
                >
                  <option>Anime</option>
                  <option>Oil Painting</option>
                  <option>Watercolor</option>
                  <option>Pixel Art</option>
                  <option>Sketch</option>
                  <option>Pop Art</option>
                </select>
              </div>
            )}

            {mode === 'custom' && (
              <div className="bg-white/5 border border-white/10 rounded-xl p-4">
                <div className="text-sm text-slate-300 mb-2">Custom Prompt</div>
                <textarea
                  className="w-full bg-slate-900 border border-white/10 rounded-lg px-3 py-2 min-h-[100px]"
                  value={customPrompt}
                  onChange={(e) => setCustomPrompt(e.target.value)}
                  placeholder="Type your edit instructions..."
                />
              </div>
            )}

            <Button
              className="w-full bg-gradient-to-r from-violet-500 to-indigo-500 hover:from-violet-600 hover:to-indigo-600 text-white py-6 text-lg rounded-xl"
              disabled={isWorking || (!file && !uploadedUrl)}
              onClick={() => void runEdit()}
            >
              {isWorking ? (
                <>
                  <Loader2 className="w-5 h-5 mr-2 animate-spin" />
                  {progressText ?? 'Working...'}
                </>
              ) : (
                <>
                  <Wand2 className="w-5 h-5 mr-2" />
                  Generate Edit
                </>
              )}
            </Button>

            {error && (
              <div className="rounded-xl border border-red-500/30 bg-red-500/10 p-4 text-red-100 flex items-center justify-between gap-3">
                <div className="text-sm">{error}</div>
                <Button
                  variant="outline"
                  className="border-red-500/40 text-red-100 hover:bg-red-500/20"
                  onClick={() => void runEdit()}
                  disabled={isWorking}
                >
                  Retry
                </Button>
              </div>
            )}

            <div className="bg-white/5 border border-white/10 rounded-xl p-4">
              <div className="text-sm text-slate-300 mb-3 flex items-center justify-between">
                <span>History</span>
                <span className="text-xs text-slate-400">Last 10</span>
              </div>
              <div className="space-y-2">
                {history.length === 0 ? (
                  <div className="text-sm text-slate-400">No edits yet.</div>
                ) : (
                  history.slice(0, 10).map((h) => (
                    <div key={h.id} className="flex items-center justify-between gap-3 bg-white/5 border border-white/10 rounded-lg px-3 py-2">
                      <div className="min-w-0">
                        <div className="text-sm truncate">{h.label}</div>
                        <div className="text-xs text-slate-400 truncate">{h.model} · seed {h.seed}</div>
                      </div>
                      <Button
                        variant="outline"
                        className="border-white/15 text-white hover:bg-white/10"
                        onClick={() => void runEdit({ uploadedUrl: h.uploadedUrl, seed: h.seed, model: h.model, prompt: h.prompt, label: h.label })}
                        disabled={isWorking}
                      >
                        Load
                      </Button>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>

          <div className="space-y-4">
            <div className="bg-white/5 border border-white/10 rounded-3xl p-5">
              {!previewUrl ? (
                <div className="h-[420px] flex items-center justify-center text-slate-400">
                  Upload an image to start editing.
                </div>
              ) : (
                <div className="space-y-4">
                  <div className="relative rounded-2xl overflow-hidden bg-black/30">
                    <div className="relative w-full h-[420px]">
                      {resultUrl && (
                        <img
                          src={resultUrl}
                          alt="After"
                          crossOrigin="anonymous"
                          onError={() => setError('Generation failed, please try again')}
                          className="absolute inset-0 w-full h-full object-contain"
                        />
                      )}
                      <img
                        src={previewUrl}
                        alt="Before"
                        className="absolute inset-0 w-full h-full object-contain"
                        style={resultUrl ? { clipPath: `inset(0 ${100 - compare}% 0 0)` } : undefined}
                      />
                      {resultUrl && (
                        <div className="absolute inset-y-0" style={{ left: `${compare}%` }}>
                          <div className="w-0.5 h-full bg-white/70" />
                        </div>
                      )}
                    </div>
                  </div>

                  {resultUrl && (
                    <div className="space-y-3">
                      <input
                        type="range"
                        min={0}
                        max={100}
                        value={compare}
                        onChange={(e) => setCompare(Number(e.target.value))}
                        className="w-full"
                      />
                      <div className="grid grid-cols-2 gap-3">
                        <Button className="bg-gray-900 text-white hover:bg-gray-800" onClick={handleDownload}>
                          <Download className="w-4 h-4 mr-2" />
                          Download
                        </Button>
                        <Button
                          variant="outline"
                          className="border-white/15 text-white hover:bg-white/10"
                          onClick={() => void runEdit()}
                          disabled={isWorking}
                        >
                          Retry
                        </Button>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}

// ==================== COLORIZE DRAWING ====================
function ColorizeSection() {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [drawingFile, setDrawingFile] = useState<File | null>(null);
  const [drawingPreviewUrl, setDrawingPreviewUrl] = useState<string | null>(null);
  const [isColorizing, setIsColorizing] = useState(false);
  const [resultUrl, setResultUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!drawingFile) {
      setDrawingPreviewUrl((prev) => {
        if (prev?.startsWith('blob:')) URL.revokeObjectURL(prev);
        return null;
      });
      return;
    }

    const url = URL.createObjectURL(drawingFile);
    setDrawingPreviewUrl((prev) => {
      if (prev?.startsWith('blob:')) URL.revokeObjectURL(prev);
      return url;
    });

    return () => URL.revokeObjectURL(url);
  }, [drawingFile]);

  useEffect(() => {
    return () => {
      if (resultUrl?.startsWith('blob:')) URL.revokeObjectURL(resultUrl);
    };
  }, [resultUrl]);

  const handleFileSelect = (file: File) => {
    if (!file.type.startsWith('image/')) {
      setError('Please upload an image file.')
      return
    }
    if (file.size > 10 * 1024 * 1024) {
      setError('File too large. Max 10MB.')
      return
    }
    setError(null)
    setDrawingFile(file)
    setResultUrl((prev) => {
      if (prev?.startsWith('blob:')) URL.revokeObjectURL(prev)
      return null
    })
  }

  const handleColorize = async () => {
    if (!drawingFile) {
      setError('Please choose a black & white image first.')
      return
    }

    setError(null)
    setIsColorizing(true)

    try {
      const prompt =
        'Colorize this black and white photo with highly realistic natural colors, preserve all details, textures and lighting'
      const seed = makePollinationsSeed()
      const imageUrl = await uploadToPollinations(drawingFile)
      const url = buildPollinationsImageUrl(prompt, {
        image: imageUrl,
        model: 'kontext',
        nologo: true,
        width: 1024,
        height: 1024,
        seed,
      })
      setResultUrl(url)
      await preloadImage(url)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Colorization failed')
    } finally {
      setIsColorizing(false)
    }
  }

  const handleDownload = async () => {
    if (!resultUrl) return
    fetch(resultUrl)
      .then((res) => res.blob())
      .then((blob) => {
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = 'colorized.png'
        a.click()
        window.setTimeout(() => URL.revokeObjectURL(url), 10_000)
      })
      .catch(() => {
        window.open(resultUrl, '_blank', 'noopener,noreferrer')
      })
  }

  return (
    <section id="colorize-feature" className="py-20 bg-gradient-to-br from-slate-50 via-indigo-50 to-emerald-50">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="grid lg:grid-cols-2 gap-16 items-center">
          <div className="space-y-8 order-2 lg:order-1">
            <div>
              <Badge className="bg-indigo-100 text-indigo-700 mb-4">AI Colorization</Badge>
              <h2 className="text-3xl lg:text-5xl font-bold text-gray-900 mb-4">
                Colorize <span className="text-gradient">Black & White Photos</span>
              </h2>
              <p className="text-lg text-gray-600 leading-relaxed">
                Upload a black-and-white image and get a highly realistic colorized result with natural colors while preserving details and lighting.
              </p>
            </div>
            
            <div className="grid sm:grid-cols-2 gap-4">
              {[
                { icon: Palette, title: 'Custom Colors', desc: 'Specify exact colors for elements' },
                { icon: Zap, title: 'Instant Results', desc: 'See colors applied in seconds' },
                { icon: Download, title: 'High Quality', desc: 'Download in full resolution' },
                { icon: Share2, title: 'Easy Sharing', desc: 'Share directly to social media' },
              ].map((item, index) => (
                <div key={index} className="flex items-start gap-3">
                  <item.icon className="w-5 h-5 text-indigo-600 mt-0.5" />
                  <div>
                    <h4 className="font-medium text-gray-900">{item.title}</h4>
                    <p className="text-sm text-gray-500">{item.desc}</p>
                  </div>
                </div>
              ))}
            </div>

            <div className="space-y-3">
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0]
                  if (file) handleFileSelect(file)
                }}
              />
              <div
                role="button"
                tabIndex={0}
                className={`rounded-xl border-2 border-dashed p-6 bg-white transition-colors ${isDragging ? 'border-indigo-500 bg-indigo-50' : 'border-gray-200 hover:border-indigo-300'}`}
                onClick={() => fileInputRef.current?.click()}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') fileInputRef.current?.click()
                }}
                onDragEnter={(e) => {
                  e.preventDefault()
                  setIsDragging(true)
                }}
                onDragOver={(e) => {
                  e.preventDefault()
                  setIsDragging(true)
                }}
                onDragLeave={(e) => {
                  e.preventDefault()
                  setIsDragging(false)
                }}
                onDrop={(e) => {
                  e.preventDefault()
                  setIsDragging(false)
                  const file = e.dataTransfer.files?.[0]
                  if (file) handleFileSelect(file)
                }}
              >
                <div className="flex items-center gap-3">
                  <Upload className="w-5 h-5 text-indigo-600" />
                  <div className="flex-1">
                    <div className="font-medium text-gray-900">
                      {drawingFile ? drawingFile.name : 'Choose a file or drag and drop'}
                    </div>
                    <div className="text-sm text-gray-500">PNG, JPG, WEBP up to 10MB</div>
                  </div>
                  {drawingFile && (
                    <Button
                      type="button"
                      variant="outline"
                      onClick={(e) => {
                        e.stopPropagation()
                        setDrawingFile(null)
                        setResultUrl((prev) => {
                          if (prev?.startsWith('blob:')) URL.revokeObjectURL(prev)
                          return null
                        })
                      }}
                    >
                      <X className="w-4 h-4" />
                    </Button>
                  )}
                </div>
              </div>
              <Button
                onClick={handleColorize}
                disabled={isColorizing || !drawingFile}
                className="bg-gradient-to-r from-indigo-600 to-emerald-500 hover:from-indigo-700 hover:to-emerald-600 text-white px-8 py-6 text-lg rounded-xl"
              >
                <Paintbrush className="w-5 h-5 mr-2" />
                {isColorizing ? 'Colorizing...' : 'Colorize Image'}
              </Button>
              {error && <div className="text-sm text-red-600">{error}</div>}
            </div>
          </div>
          
          <div className="order-1 lg:order-2">
            <div className="relative">
              <div className="bg-white rounded-3xl shadow-2xl p-6">
                {drawingPreviewUrl && (resultUrl || isColorizing) ? (
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div className="bg-gray-50 rounded-2xl p-3">
                      <img src={drawingPreviewUrl} alt="Original" className="rounded-xl w-full h-64 object-contain" />
                      <p className="text-center text-sm text-gray-500 mt-2">Original</p>
                    </div>
                    <div className="bg-gray-50 rounded-2xl p-3 flex items-center justify-center">
                      {isColorizing ? (
                        <div className="flex flex-col items-center gap-3 py-12">
                          <Loader2 className="w-8 h-8 text-indigo-600 animate-spin" />
                          <div className="text-sm text-gray-600">Colorizing...</div>
                        </div>
                      ) : resultUrl ? (
                        <div className="w-full">
                          <img
                            src={resultUrl}
                            alt="Colorized"
                            crossOrigin="anonymous"
                            onError={() => setError('Generation failed, please try again')}
                            className="rounded-xl w-full h-64 object-contain"
                          />
                          <p className="text-center text-sm text-gray-500 mt-2">Colorized</p>
                          <div className="mt-3">
                            <Button className="w-full bg-gray-900 text-white hover:bg-gray-800" onClick={handleDownload}>
                              <Download className="w-4 h-4 mr-2" />
                              Download
                            </Button>
                          </div>
                        </div>
                      ) : null}
                    </div>
                  </div>
                ) : (
                  <div className="relative rounded-2xl overflow-hidden">
                    <img src="/lion.jpg" alt="Example colorized" className="w-full h-auto" />
                    <div className="absolute inset-0 bg-gradient-to-r from-transparent via-white/20 to-transparent animate-shimmer" />
                  </div>
                )}
              </div>
            </div>

          </div>
        </div>
      </div>
    </section>
  );
}

// ==================== GALLERY SECTION ====================
function GallerySection() {
  const [activeFilter, setActiveFilter] = useState('all');
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid');

  const filters = [
    { id: 'all', label: 'All', count: 32 },
    { id: 'animals', label: 'Animals', count: 8 },
    { id: 'cartoons', label: 'Cartoons', count: 6 },
    { id: 'fantasy', label: 'Fantasy', count: 5 },
    { id: 'holidays', label: 'Holidays', count: 4 },
    { id: 'nature', label: 'Nature', count: 9 },
  ];

  const coloringPages = [
    { id: 1, image: '/deer.jpg', title: 'Cute Deer in Forest', category: 'animals', pages: '68', downloads: '2.4k', likes: 156 },
    { id: 2, image: '/dog.jpg', title: 'Puppy with Flowers', category: 'animals', pages: '40', downloads: '1.8k', likes: 124 },
    { id: 3, image: '/hellokitty.jpg', title: 'Hello Kitty Style', category: 'cartoons', pages: '52', downloads: '3.2k', likes: 289 },
    { id: 4, image: '/cityscape.jpg', title: 'Magical Cityscape', category: 'fantasy', pages: '77', downloads: '1.5k', likes: 98 },
    { id: 5, image: '/rabbit-lake.jpg', title: 'Rabbit by the Lake', category: 'animals', pages: '39', downloads: '2.1k', likes: 167 },
    { id: 6, image: '/mermaid-yoga.jpg', title: 'Mermaid Yoga', category: 'fantasy', pages: '50', downloads: '2.8k', likes: 234 },
    { id: 7, image: '/butterfly.jpg', title: 'Butterfly Garden', category: 'nature', pages: '45', downloads: '1.9k', likes: 145 },
    { id: 8, image: '/unicorn.jpg', title: 'Magical Unicorn', category: 'fantasy', pages: '62', downloads: '3.5k', likes: 312 },
    { id: 9, image: '/christmas-tree.jpg', title: 'Christmas Tree', category: 'holidays', pages: '38', downloads: '2.2k', likes: 178 },
    { id: 10, image: '/halloween.jpg', title: 'Halloween Pumpkin', category: 'holidays', pages: '42', downloads: '1.6k', likes: 134 },
    { id: 11, image: '/princess.jpg', title: 'Princess & Castle', category: 'fantasy', pages: '55', downloads: '2.9k', likes: 256 },
    { id: 12, image: '/dragon.jpg', title: 'Cute Dragon', category: 'fantasy', pages: '48', downloads: '2.3k', likes: 189 },
  ];

  const filteredPages = activeFilter === 'all' 
    ? coloringPages 
    : coloringPages.filter(page => page.category === activeFilter);

  return (
    <section id="gallery" className="py-20 bg-white">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="text-center mb-12">
          <Badge className="bg-green-100 text-green-600 mb-4">Free Library</Badge>
          <h2 className="text-3xl lg:text-5xl font-bold text-gray-900 mb-4">
            Browse 32,017+ Free Coloring Pages
          </h2>
          <p className="text-lg text-gray-600 max-w-2xl mx-auto">
            Download and print thousands of free coloring pages. New designs added daily!
          </p>
        </div>
        
        {/* Search & Filters */}
        <div className="mb-8">
          <div className="flex flex-col lg:flex-row gap-4 mb-6">
            <div className="flex-1 relative">
              <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400" />
              <Input 
                placeholder="Search coloring pages..."
                className="pl-12 h-14 text-lg"
              />
            </div>
            <div className="flex gap-2">
              <Button variant="outline" className="h-14 px-6">
                <Filter className="w-5 h-5 mr-2" />
                Filters
              </Button>
              <div className="flex border rounded-lg overflow-hidden">
                <button 
                  onClick={() => setViewMode('grid')}
                  className={`p-4 ${viewMode === 'grid' ? 'bg-indigo-100 text-indigo-700' : 'text-gray-500'}`}
                >
                  <Grid3X3 className="w-5 h-5" />
                </button>
                <button 
                  onClick={() => setViewMode('list')}
                  className={`p-4 ${viewMode === 'list' ? 'bg-indigo-100 text-indigo-700' : 'text-gray-500'}`}
                >
                  <List className="w-5 h-5" />
                </button>
              </div>
            </div>
          </div>
          
          {/* Category Filters */}
          <div className="flex flex-wrap gap-2 justify-center">
            {filters.map((filter) => (
              <button
                key={filter.id}
                onClick={() => setActiveFilter(filter.id)}
                className={`px-4 py-2 rounded-full text-sm font-medium transition-colors ${
                  activeFilter === filter.id
                    ? 'bg-gradient-to-r from-indigo-600 to-emerald-500 text-white'
                    : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                }`}
              >
                {filter.label}
                <span className="ml-1 opacity-70">({filter.count})</span>
              </button>
            ))}
          </div>
        </div>
        
        {/* Gallery Grid */}
        <div className={`grid ${viewMode === 'grid' ? 'sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4' : 'grid-cols-1'} gap-6`}>
          {filteredPages.map((page) => (
            <Dialog key={page.id}>
              <DialogTrigger asChild>
                <div className={`group cursor-pointer bg-white rounded-2xl overflow-hidden border border-gray-100 hover:shadow-xl transition-all ${viewMode === 'list' ? 'flex' : ''}`}>
                  <div className={`relative overflow-hidden ${viewMode === 'list' ? 'w-48 h-48' : 'aspect-square'}`}>
                    <img 
                      src={page.image} 
                      alt={page.title}
                      className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500"
                    />
                    <div className="absolute inset-0 bg-black/0 group-hover:bg-black/20 transition-colors" />
                    <div className="absolute top-3 right-3 opacity-0 group-hover:opacity-100 transition-opacity">
                      <Button size="sm" className="bg-white text-gray-900 hover:bg-gray-100">
                        <Eye className="w-4 h-4 mr-1" />
                        Preview
                      </Button>
                    </div>
                  </div>
                  <div className="p-4 flex-1">
                    <div className="flex items-center gap-2 text-xs text-gray-500 mb-2">
                      <Download className="w-3 h-3" />
                      <span>Free PDF/PNG</span>
                    </div>
                    <h3 className="font-semibold text-gray-900 mb-2">{page.title}</h3>
                    <div className="flex items-center justify-between text-sm text-gray-500">
                      <span>{page.pages} Pages</span>
                      <div className="flex items-center gap-3">
                        <span className="flex items-center gap-1">
                          <Download className="w-3 h-3" />
                          {page.downloads}
                        </span>
                        <span className="flex items-center gap-1">
                          <Heart className="w-3 h-3" />
                          {page.likes}
                        </span>
                      </div>
                    </div>
                  </div>
                </div>
              </DialogTrigger>
              <DialogContent className="max-w-3xl">
                <DialogHeader>
                  <DialogTitle>{page.title}</DialogTitle>
                </DialogHeader>
                <div className="grid md:grid-cols-2 gap-6">
                  <img src={page.image} alt={page.title} className="rounded-xl w-full" />
                  <div className="space-y-4">
                    <p className="text-gray-600">Download this beautiful coloring page for free!</p>
                    <div className="flex gap-2">
                      <Button className="flex-1 bg-gradient-to-r from-indigo-600 to-emerald-500 text-white">
                        <Download className="w-4 h-4 mr-2" />
                        Download PDF
                      </Button>
                      <Button variant="outline" className="flex-1">
                        <Download className="w-4 h-4 mr-2" />
                        Download PNG
                      </Button>
                    </div>
                    <div className="flex gap-2">
                      <Button variant="outline" size="sm">
                        <Heart className="w-4 h-4 mr-1" />
                        Favorite
                      </Button>
                      <Button variant="outline" size="sm">
                        <Share2 className="w-4 h-4 mr-1" />
                        Share
                      </Button>
                    </div>
                  </div>
                </div>
              </DialogContent>
            </Dialog>
          ))}
        </div>
        
        <div className="text-center mt-12">
          <Button variant="outline" className="px-8 py-6 text-lg">
            Load More Coloring Pages
            <ChevronDown className="w-5 h-5 ml-2" />
          </Button>
        </div>
      </div>
    </section>
  );
}

// ==================== ONLINE COLORING ====================
function OnlineColoringSection() {
  const tools = [
    { icon: PenTool, name: 'Brush' as const, shortcut: 'B' },
    { icon: Paintbrush, name: 'Fill' as const, shortcut: 'F' },
    { icon: Eraser, name: 'Eraser' as const, shortcut: 'E' },
    { icon: ScanLine, name: 'Line' as const, shortcut: 'L' },
  ];

  const colors = [
    '#FF6B6B', '#4ECDC4', '#45B7D1', '#96CEB4', '#FFEAA7', '#DDA0DD',
    '#FFD93D', '#6BCB77', '#4D96FF', '#FF6B9D', '#C9B1FF', '#95DAC1'
  ];

  const [activeTool, setActiveTool] = useState<(typeof tools)[number]['name']>('Brush');
  const [activeColor, setActiveColor] = useState(colors[0]);
  const [brushSize, setBrushSize] = useState(10);
  const [status, setStatus] = useState<string | null>(null);
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);
  const [baseImageUrl, setBaseImageUrl] = useState(() => {
    try {
      const saved = localStorage.getItem('ONLINE_COLORING_STATE');
      if (saved) {
        const parsed = JSON.parse(saved) as { baseImageUrl?: unknown };
        if (typeof parsed.baseImageUrl === 'string' && !parsed.baseImageUrl.startsWith('blob:')) {
          return parsed.baseImageUrl;
        }
      }
      const selected = localStorage.getItem('ONLINE_COLORING_IMAGE_URL');
      if (typeof selected === 'string' && selected && !selected.startsWith('blob:')) return selected;
    } catch {
      return '/butterfly.jpg';
    }
    return '/butterfly.jpg';
  });

  useEffect(() => {
    const handler = (event: Event) => {
      const e = event as CustomEvent<{ url?: unknown }>
      const url = e.detail?.url
      if (typeof url !== 'string' || !url) return
      setBaseImageUrl((prev) => {
        if (prev?.startsWith('blob:')) URL.revokeObjectURL(prev)
        return url
      })
      try {
        if (!url.startsWith('blob:')) localStorage.setItem('ONLINE_COLORING_IMAGE_URL', url)
      } catch {
        return
      }
    }
    window.addEventListener('online-coloring:set-image', handler)
    return () => {
      window.removeEventListener('online-coloring:set-image', handler)
    }
  }, []);

  const baseCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const drawCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const beforeActionRef = useRef<ImageData | null>(null);
  const undoStackRef = useRef<ImageData[]>([]);
  const redoStackRef = useRef<ImageData[]>([]);
  const isPointerDownRef = useRef(false);
  const lastPointRef = useRef<{ x: number; y: number } | null>(null);
  const lineStartRef = useRef<{ x: number; y: number } | null>(null);

  const syncHistoryState = () => {
    setCanUndo(undoStackRef.current.length > 0);
    setCanRedo(redoStackRef.current.length > 0);
  };

  const parseHex = (hex: string) => {
    const raw = hex.replace('#', '').trim();
    const value = raw.length === 3
      ? raw.split('').map((c) => c + c).join('')
      : raw;
    const r = Number.parseInt(value.slice(0, 2), 16);
    const g = Number.parseInt(value.slice(2, 4), 16);
    const b = Number.parseInt(value.slice(4, 6), 16);
    return { r, g, b, a: 255 };
  };

  const getPointOnCanvas = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = drawCanvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    const x = Math.max(0, Math.min(canvas.width - 1, (e.clientX - rect.left) * scaleX));
    const y = Math.max(0, Math.min(canvas.height - 1, (e.clientY - rect.top) * scaleY));
    return { x, y };
  };

  const getDrawCtx = () => {
    const canvas = drawCanvasRef.current;
    if (!canvas) return null;
    return canvas.getContext('2d');
  };

  const saveStateToStorage = () => {
    try {
      const drawCanvas = drawCanvasRef.current;
      if (!drawCanvas) return;
      const overlay = drawCanvas.toDataURL('image/png');
      localStorage.setItem(
        'ONLINE_COLORING_STATE',
        JSON.stringify({ baseImageUrl, overlay })
      );
      setStatus('Saved');
      window.setTimeout(() => setStatus(null), 1500);
    } catch {
      setStatus('Save failed');
      window.setTimeout(() => setStatus(null), 2000);
    }
  };

  useEffect(() => {
    let cancelled = false;
    const baseCanvas = baseCanvasRef.current;
    const drawCanvas = drawCanvasRef.current;
    if (!baseCanvas || !drawCanvas) return;

    const baseCtx = baseCanvas.getContext('2d');
    const drawCtx = drawCanvas.getContext('2d');
    if (!baseCtx || !drawCtx) return;

    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.src = baseImageUrl;

    img.onload = async () => {
      if (cancelled) return;
      const maxWidth = 1024;
      const scale = img.naturalWidth > maxWidth ? maxWidth / img.naturalWidth : 1;
      const width = Math.max(1, Math.round(img.naturalWidth * scale));
      const height = Math.max(1, Math.round(img.naturalHeight * scale));

      baseCanvas.width = width;
      baseCanvas.height = height;
      drawCanvas.width = width;
      drawCanvas.height = height;

      baseCtx.clearRect(0, 0, width, height);
      baseCtx.fillStyle = '#ffffff';
      baseCtx.fillRect(0, 0, width, height);
      baseCtx.drawImage(img, 0, 0, width, height);

      drawCtx.clearRect(0, 0, width, height);
      undoStackRef.current = [];
      redoStackRef.current = [];
      beforeActionRef.current = null;
      setCanUndo(false);
      setCanRedo(false);
      try {
        const saved = localStorage.getItem('ONLINE_COLORING_STATE');
        if (saved) {
          const parsed = JSON.parse(saved) as { overlay?: unknown };
          if (typeof parsed.overlay === 'string' && parsed.overlay) {
            const overlayImg = new Image();
            overlayImg.crossOrigin = 'anonymous';
            overlayImg.src = parsed.overlay;
            await new Promise<void>((resolve, reject) => {
              overlayImg.onload = () => resolve();
              overlayImg.onerror = () => reject(new Error('Overlay load failed'));
            });
            drawCtx.drawImage(overlayImg, 0, 0, width, height);
          }
        }
      } catch {
        return;
      }
      setStatus(null);
    };

    img.onerror = () => {
      if (cancelled) return;
      setStatus('Image load failed');
      window.setTimeout(() => setStatus(null), 2000);
    };

    return () => {
      cancelled = true;
    };
  }, [baseImageUrl]);

  const pushUndoBefore = () => {
    const ctx = getDrawCtx();
    const canvas = drawCanvasRef.current;
    if (!ctx || !canvas) return;
    beforeActionRef.current = ctx.getImageData(0, 0, canvas.width, canvas.height);
  };

  const commitUndo = () => {
    const before = beforeActionRef.current;
    if (!before) return;
    undoStackRef.current.push(before);
    redoStackRef.current = [];
    beforeActionRef.current = null;
    syncHistoryState();
  };

  const undo = () => {
    const ctx = getDrawCtx();
    const canvas = drawCanvasRef.current;
    if (!ctx || !canvas) return;
    const previous = undoStackRef.current.pop();
    if (!previous) return;
    const current = ctx.getImageData(0, 0, canvas.width, canvas.height);
    redoStackRef.current.push(current);
    ctx.putImageData(previous, 0, 0);
    syncHistoryState();
  };

  const redo = () => {
    const ctx = getDrawCtx();
    const canvas = drawCanvasRef.current;
    if (!ctx || !canvas) return;
    const next = redoStackRef.current.pop();
    if (!next) return;
    const current = ctx.getImageData(0, 0, canvas.width, canvas.height);
    undoStackRef.current.push(current);
    ctx.putImageData(next, 0, 0);
    syncHistoryState();
  };

  const download = () => {
    const baseCanvas = baseCanvasRef.current;
    const drawCanvas = drawCanvasRef.current;
    if (!baseCanvas || !drawCanvas) return;

    try {
      const out = document.createElement('canvas');
      out.width = baseCanvas.width;
      out.height = baseCanvas.height;
      const outCtx = out.getContext('2d');
      if (!outCtx) return;
      outCtx.drawImage(baseCanvas, 0, 0);
      outCtx.drawImage(drawCanvas, 0, 0);
      const url = out.toDataURL('image/png');
      const a = document.createElement('a');
      a.href = url;
      a.download = 'coloring.png';
      a.click();
    } catch {
      setStatus('Download failed');
      window.setTimeout(() => setStatus(null), 2000);
    }
  };

  const fillAt = (x: number, y: number) => {
    const baseCanvas = baseCanvasRef.current;
    const drawCanvas = drawCanvasRef.current;
    const drawCtx = getDrawCtx();
    if (!baseCanvas || !drawCanvas || !drawCtx) return;

    const w = drawCanvas.width;
    const h = drawCanvas.height;

    const composite = document.createElement('canvas');
    composite.width = w;
    composite.height = h;
    const compositeCtx = composite.getContext('2d');
    if (!compositeCtx) return;
    compositeCtx.drawImage(baseCanvas, 0, 0);
    compositeCtx.drawImage(drawCanvas, 0, 0);

    const compositeData = compositeCtx.getImageData(0, 0, w, h);
    const drawData = drawCtx.getImageData(0, 0, w, h);
    const data = compositeData.data;
    const out = drawData.data;

    const startX = Math.floor(x);
    const startY = Math.floor(y);
    const startIndex = (startY * w + startX) * 4;

    const target = {
      r: data[startIndex],
      g: data[startIndex + 1],
      b: data[startIndex + 2],
      a: data[startIndex + 3],
    };
    const fill = parseHex(activeColor);

    const dist = (r: number, g: number, b: number, a: number) =>
      Math.abs(r - target.r) + Math.abs(g - target.g) + Math.abs(b - target.b) + Math.abs(a - target.a);
    const isBarrier = (r: number, g: number, b: number, a: number) =>
      a > 80 && r < 40 && g < 40 && b < 40;

    if (dist(fill.r, fill.g, fill.b, fill.a) < 10) return;

    const tolerance = 80;
    const visited = new Uint8Array(w * h);
    const stack: Array<[number, number]> = [[startX, startY]];

    while (stack.length) {
      const item = stack.pop();
      if (!item) break;
      const [cx, cy] = item;
      if (cx < 0 || cy < 0 || cx >= w || cy >= h) continue;
      const pos = cy * w + cx;
      if (visited[pos]) continue;
      visited[pos] = 1;

      const idx = pos * 4;
      const r = data[idx];
      const g = data[idx + 1];
      const b = data[idx + 2];
      const a = data[idx + 3];

      if (isBarrier(r, g, b, a)) continue;
      if (dist(r, g, b, a) > tolerance) continue;

      out[idx] = fill.r;
      out[idx + 1] = fill.g;
      out[idx + 2] = fill.b;
      out[idx + 3] = 255;

      stack.push([cx + 1, cy]);
      stack.push([cx - 1, cy]);
      stack.push([cx, cy + 1]);
      stack.push([cx, cy - 1]);
    }

    drawCtx.putImageData(drawData, 0, 0);
  };

  const beginStroke = (point: { x: number; y: number }) => {
    const ctx = getDrawCtx();
    if (!ctx) return;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.lineWidth = brushSize;
    if (activeTool === 'Eraser') {
      ctx.globalCompositeOperation = 'destination-out';
      ctx.strokeStyle = 'rgba(0,0,0,1)';
    } else {
      ctx.globalCompositeOperation = 'source-over';
      ctx.strokeStyle = activeColor;
    }
    ctx.beginPath();
    ctx.moveTo(point.x, point.y);
  };

  const strokeTo = (point: { x: number; y: number }) => {
    const ctx = getDrawCtx();
    if (!ctx) return;
    ctx.lineTo(point.x, point.y);
    ctx.stroke();
  };

  const drawLinePreview = (from: { x: number; y: number }, to: { x: number; y: number }) => {
    const ctx = getDrawCtx();
    const canvas = drawCanvasRef.current;
    if (!ctx || !canvas) return;
    const before = beforeActionRef.current;
    if (!before) return;
    ctx.putImageData(before, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.lineWidth = brushSize;
    ctx.strokeStyle = activeColor;
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(to.x, to.y);
    ctx.stroke();
  };

  return (
    <section id="online-coloring" className="py-20 bg-gray-900 text-white">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="text-center mb-12">
          <Badge className="bg-indigo-600 text-white mb-4">Try It Now</Badge>
          <h2 className="text-3xl lg:text-5xl font-bold mb-4">Color Online - No Download Needed</h2>
          <p className="text-lg text-gray-400 max-w-2xl mx-auto">
            Use our free online coloring tool to color pages directly in your browser. 
            Save your progress and share your creations!
          </p>
        </div>
        
        <div className="bg-gray-800 rounded-3xl p-4 lg:p-8">
          <div className="grid lg:grid-cols-4 gap-6">
            {/* Tools Panel */}
            <div className="lg:col-span-1 space-y-6">
              <div>
                <h4 className="text-sm font-medium text-gray-400 mb-3">Page</h4>
                <Input
                  type="file"
                  accept="image/*"
                  className="bg-gray-800 border-gray-700 text-white"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (!file) return;
                    const url = URL.createObjectURL(file);
                    setBaseImageUrl((prev) => {
                      if (prev?.startsWith('blob:')) URL.revokeObjectURL(prev);
                      return url;
                    });
                  }}
                />
              </div>

              <div>
                <h4 className="text-sm font-medium text-gray-400 mb-3">Tools</h4>
                <div className="grid grid-cols-2 gap-2">
                  {tools.map((tool, index) => (
                    <button 
                      key={index}
                      className={`p-3 rounded-xl flex flex-col items-center gap-1 transition-colors ${
                        tool.name === activeTool ? 'bg-indigo-600 text-white' : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
                      }`}
                      onClick={() => setActiveTool(tool.name)}
                    >
                      <tool.icon className="w-5 h-5" />
                      <span className="text-xs">{tool.name}</span>
                    </button>
                  ))}
                </div>
              </div>
              
              <div>
                <h4 className="text-sm font-medium text-gray-400 mb-3">Colors</h4>
                <div className="grid grid-cols-4 gap-2">
                  {colors.map((color, index) => (
                    <button 
                      key={index}
                      className={`w-10 h-10 rounded-lg border-2 transition-colors ${
                        color === activeColor ? 'border-white' : 'border-transparent hover:border-white/60'
                      }`}
                      style={{ backgroundColor: color }}
                      onClick={() => setActiveColor(color)}
                    />
                  ))}
                </div>
              </div>
              
              <div>
                <h4 className="text-sm font-medium text-gray-400 mb-3">Brush Size</h4>
                <input
                  type="range"
                  className="w-full"
                  min="1"
                  max="50"
                  value={brushSize}
                  onChange={(e) => setBrushSize(Number(e.target.value))}
                />
                <div className="text-xs text-gray-400 mt-1">{brushSize}px</div>
              </div>
            </div>
            
            {/* Canvas Area */}
            <div className="lg:col-span-3">
              <div className="bg-white rounded-2xl overflow-hidden relative">
                <canvas ref={baseCanvasRef} className="w-full h-auto max-h-[600px] object-contain block" />
                <canvas
                  ref={drawCanvasRef}
                  className="absolute inset-0 w-full h-auto max-h-[600px] object-contain touch-none"
                  onPointerDown={(e) => {
                    const canvas = drawCanvasRef.current;
                    const ctx = getDrawCtx();
                    if (!canvas || !ctx) return;
                    const point = getPointOnCanvas(e);
                    if (!point) return;
                    canvas.setPointerCapture(e.pointerId);
                    pushUndoBefore();

                    if (activeTool === 'Fill') {
                      isPointerDownRef.current = true;
                      fillAt(point.x, point.y);
                      commitUndo();
                      isPointerDownRef.current = false;
                      return;
                    }

                    if (activeTool === 'Line') {
                      isPointerDownRef.current = true;
                      lineStartRef.current = point;
                      return;
                    }

                    isPointerDownRef.current = true;
                    lastPointRef.current = point;
                    beginStroke(point);
                  }}
                  onPointerMove={(e) => {
                    if (!isPointerDownRef.current) return;
                    const point = getPointOnCanvas(e);
                    if (!point) return;

                    if (activeTool === 'Line') {
                      const start = lineStartRef.current;
                      if (!start) return;
                      drawLinePreview(start, point);
                      return;
                    }

                    const last = lastPointRef.current;
                    if (!last) return;
                    strokeTo(point);
                    lastPointRef.current = point;
                  }}
                  onPointerUp={(e) => {
                    const canvas = drawCanvasRef.current;
                    if (!canvas) return;
                    if (!isPointerDownRef.current && activeTool !== 'Line') return;
                    const point = getPointOnCanvas(e);
                    canvas.releasePointerCapture(e.pointerId);

                    if (activeTool === 'Line') {
                      const start = lineStartRef.current;
                      if (start && point) {
                        drawLinePreview(start, point);
                        commitUndo();
                      } else {
                        beforeActionRef.current = null;
                      }
                      lineStartRef.current = null;
                      isPointerDownRef.current = false;
                      return;
                    }

                    const ctx = getDrawCtx();
                    if (ctx && activeTool === 'Eraser') ctx.globalCompositeOperation = 'source-over';
                    commitUndo();
                    isPointerDownRef.current = false;
                    lastPointRef.current = null;
                  }}
                  onPointerCancel={(e) => {
                    const canvas = drawCanvasRef.current;
                    if (!canvas) return;
                    canvas.releasePointerCapture(e.pointerId);
                    const ctx = getDrawCtx();
                    if (ctx) ctx.globalCompositeOperation = 'source-over';
                    beforeActionRef.current = null;
                    isPointerDownRef.current = false;
                    lastPointRef.current = null;
                    lineStartRef.current = null;
                  }}
                />
              </div>
              
              <div className="flex justify-between items-center mt-4">
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    className="border-gray-600 text-gray-300 hover:bg-gray-700"
                    onClick={undo}
                    disabled={!canUndo}
                  >
                    <Undo className="w-4 h-4 mr-2" />
                    Undo
                  </Button>
                  <Button
                    variant="outline"
                    className="border-gray-600 text-gray-300 hover:bg-gray-700"
                    onClick={redo}
                    disabled={!canRedo}
                  >
                    <Redo className="w-4 h-4 mr-2" />
                    Redo
                  </Button>
                </div>
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    className="border-gray-600 text-gray-300 hover:bg-gray-700"
                    onClick={saveStateToStorage}
                  >
                    <Bookmark className="w-4 h-4 mr-2" />
                    Save
                  </Button>
                  <Button className="bg-gradient-to-r from-indigo-600 to-emerald-500 text-white" onClick={download}>
                    <Download className="w-4 h-4 mr-2" />
                    Download
                  </Button>
                </div>
              </div>

              {status && (
                <div className="mt-3 text-sm text-gray-300">
                  {status}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

// ==================== TESTIMONIALS ====================
function TestimonialsSection() {
  const testimonials = [
    {
      name: 'Sarah Mitchell',
      role: 'Elementary School Teacher',
      image: '/testimonial-1.jpg',
      text: 'This tool has transformed my classroom! I can create custom coloring pages that match our lesson themes. The kids absolutely love them, and it saves me hours of prep time.',
      rating: 5
    },
    {
      name: 'Michael Chen',
      role: 'Amazon KDP Seller',
      image: '/testimonial-2.jpg',
      text: 'I\'ve published over 50 coloring books using this platform. The quality is exceptional, and the coloring book generator with consistent characters is a game-changer for my business.',
      rating: 5
    },
    {
      name: 'Emily Rodriguez',
      role: 'Etsy Shop Owner',
      text: 'The photo-to-coloring feature is incredible! My customers love ordering personalized coloring pages of their pets. Sales have increased by 300% since I started using this tool.',
      rating: 5
    }
  ];

  return (
    <section className="py-20 bg-gradient-to-br from-slate-50 via-indigo-50 to-emerald-50">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="text-center mb-16">
          <Badge className="bg-indigo-100 text-indigo-700 mb-4">Testimonials</Badge>
          <h2 className="text-3xl lg:text-5xl font-bold text-gray-900 mb-4">Loved by 320,000+ Users</h2>
          <p className="text-lg text-gray-600 max-w-2xl mx-auto">
            See what our community is creating with AI-powered coloring pages
          </p>
        </div>
        
        <div className="grid md:grid-cols-3 gap-8">
          {testimonials.map((testimonial, index) => (
            <Card key={index} className="bg-white border-0 shadow-xl">
              <CardContent className="p-8">
                <div className="flex gap-1 mb-4">
                  {[...Array(testimonial.rating)].map((_, i) => (
                    <Star key={i} className="w-5 h-5 fill-yellow-400 text-yellow-400" />
                  ))}
                </div>
                <p className="text-gray-600 leading-relaxed mb-6">"{testimonial.text}"</p>
                <div className="flex items-center gap-4">
                  <img 
                    src={testimonial.image} 
                    alt={testimonial.name}
                    className="w-14 h-14 rounded-full object-cover"
                  />
                  <div>
                    <h4 className="font-semibold text-gray-900">{testimonial.name}</h4>
                    <p className="text-sm text-gray-500">{testimonial.role}</p>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
        
        {/* Stats Bar */}
        <div className="mt-16 bg-white rounded-2xl shadow-lg p-8">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-8 text-center">
            {[
              { value: '4.9/5', label: 'Average Rating', icon: Star },
              { value: '2.4M+', label: 'Pages Created', icon: Palette },
              { value: '320K+', label: 'Happy Users', icon: Users },
              { value: '50K+', label: 'Books Published', icon: BookOpen },
            ].map((stat, index) => (
              <div key={index}>
                <div className="flex justify-center mb-2">
                  <stat.icon className="w-8 h-8 text-indigo-600" />
                </div>
                <div className="text-3xl font-bold text-gray-900">{stat.value}</div>
                <div className="text-gray-500">{stat.label}</div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

// ==================== PRICING ====================
function PricingSection() {
  const [billingCycle, setBillingCycle] = useState<'monthly' | 'yearly'>('monthly');

  const plans = [
    {
      name: 'Starter',
      description: 'Perfect for personal use',
      monthlyPrice: 6.99,
      yearlyPrice: 4.99,
      features: [
        '10 coloring pages/month',
        '10-page coloring books',
        'Basic styles',
        'Email support',
        'Standard resolution'
      ],
      cta: 'Start Free Trial'
    },
    {
      name: 'Hobby',
      description: 'For creative enthusiasts',
      monthlyPrice: 13.99,
      yearlyPrice: 9.99,
      features: [
        '300 coloring pages/month',
        '50-page coloring books',
        'All styles included',
        'Priority support',
        'High resolution',
        'No watermark'
      ],
      cta: 'Start Free Trial'
    },
    {
      name: 'Professional',
      description: 'For sellers & businesses',
      monthlyPrice: 27.99,
      yearlyPrice: 19.99,
      popular: true,
      features: [
        '1,000 coloring pages/month',
        '200-page coloring books',
        'All styles + KDP Builder',
        '24/7 priority support',
        '4K resolution',
        'Commercial license',
        'Batch generation'
      ],
      cta: 'Start Free Trial'
    },
    {
      name: 'Business',
      description: 'For teams & agencies',
      monthlyPrice: 69.99,
      yearlyPrice: 49.99,
      features: [
        '5,000 coloring pages/month',
        'Unlimited coloring books',
        'All features included',
        'Dedicated account manager',
        '8K resolution',
        'API access',
        'White-label option'
      ],
      cta: 'Contact Sales'
    }
  ];

  return (
    <section className="py-20 bg-white">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="text-center mb-12">
          <Badge className="bg-indigo-100 text-indigo-700 mb-4">Pricing</Badge>
          <h2 className="text-3xl lg:text-5xl font-bold text-gray-900 mb-4">Choose Your Plan</h2>
          <p className="text-lg text-gray-600 max-w-2xl mx-auto">
            Start free and scale as you grow. All plans include a 7-day free trial.
          </p>
        </div>
        
        {/* Billing Toggle */}
        <div className="flex justify-center mb-12">
          <div className="bg-gray-100 rounded-full p-1 flex">
            <button
              onClick={() => setBillingCycle('monthly')}
              className={`px-6 py-2 rounded-full text-sm font-medium transition-colors ${
                billingCycle === 'monthly' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500'
              }`}
            >
              Monthly
            </button>
            <button
              onClick={() => setBillingCycle('yearly')}
              className={`px-6 py-2 rounded-full text-sm font-medium transition-colors flex items-center gap-2 ${
                billingCycle === 'yearly' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500'
              }`}
            >
              Yearly
              <Badge className="bg-green-500 text-white text-xs">Save 30%</Badge>
            </button>
          </div>
        </div>
        
        {/* Pricing Cards */}
        <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-6">
          {plans.map((plan, index) => (
            <Card 
              key={index} 
              className={`relative ${plan.popular ? 'border-2 border-indigo-600 shadow-xl scale-105' : 'border border-gray-200'}`}
            >
              {plan.popular && (
                <div className="absolute -top-4 left-1/2 -translate-x-1/2">
                  <Badge className="bg-gradient-to-r from-indigo-600 to-emerald-500 text-white px-4 py-1">
                    Most Popular
                  </Badge>
                </div>
              )}
              <CardHeader className="pb-4">
                <CardTitle className="text-xl">{plan.name}</CardTitle>
                <CardDescription>{plan.description}</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="mb-6">
                  <span className="text-4xl font-bold">${billingCycle === 'monthly' ? plan.monthlyPrice : plan.yearlyPrice}</span>
                  <span className="text-gray-500">/month</span>
                  {billingCycle === 'yearly' && (
                    <p className="text-sm text-green-600 mt-1">Billed annually</p>
                  )}
                </div>
                
                <ul className="space-y-3 mb-6">
                  {plan.features.map((feature, i) => (
                    <li key={i} className="flex items-start gap-2 text-sm text-gray-600">
                      <Check className="w-4 h-4 text-indigo-600 mt-0.5 flex-shrink-0" />
                      <span>{feature}</span>
                    </li>
                  ))}
                </ul>
                
                <Button 
                  className={`w-full ${
                    plan.popular 
                      ? 'bg-gradient-to-r from-indigo-600 to-emerald-500 hover:from-indigo-700 hover:to-emerald-600 text-white' 
                      : 'bg-gray-100 text-gray-900 hover:bg-gray-200'
                  }`}
                >
                  {plan.cta}
                </Button>
              </CardContent>
            </Card>
          ))}
        </div>
        
        <p className="text-center text-gray-500 mt-8">
          All plans include a 7-day free trial. No credit card required.
        </p>
      </div>
    </section>
  );
}

// ==================== FAQ ====================
function FAQSection() {
  const faqs = [
    {
      category: 'getting-started',
      question: 'What is InkBloom?',
      answer: 'InkBloom is an AI-powered studio that turns photos and text prompts into clean, print-ready coloring pages. It includes generators for single pages, simple book concepts, and colorizing drawings for quick mockups.'
    },
    {
      category: 'getting-started',
      question: 'Is it free to use?',
      answer: 'Yes! We offer a generous free plan that lets you create up to 10 coloring pages per month. For unlimited access and advanced features like the Coloring Book Generator, we offer affordable premium plans starting at just $6.99/month.'
    },
    {
      category: 'creating',
      question: 'How does the Photo to Coloring Page feature work?',
      answer: 'Simply upload any photo - it could be a pet, family member, favorite object, or scene. Our AI analyzes the image and converts it into a clean, print-ready line drawing perfect for coloring. You can adjust settings like line thickness and detail level.'
    },
    {
      category: 'creating',
      question: 'Can I create coloring books for commercial use?',
      answer: 'Absolutely! All our paid plans include commercial licenses. You can create and sell coloring books on Amazon KDP, Etsy, or any other platform. Our Professional and Business plans even include the KDP Builder feature for optimized book creation.'
    },
    {
      category: 'downloading',
      question: 'What file formats are available?',
      answer: 'We provide downloads in both PDF (for printing) and PNG (for digital use) formats. All files are high-resolution and print-ready. Professional and Business plans offer up to 8K resolution.'
    },
    {
      category: 'account',
      question: 'Can I cancel my subscription anytime?',
      answer: 'Yes, you can cancel your subscription at any time with no penalties. If you cancel, you\'ll continue to have access until the end of your billing period. We also offer a 7-day free trial for all paid plans.'
    }
  ];

  return (
    <section className="py-20 bg-gray-50">
      <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="text-center mb-12">
          <Badge className="bg-indigo-100 text-indigo-700 mb-4">FAQ</Badge>
          <h2 className="text-3xl lg:text-5xl font-bold text-gray-900 mb-4">Frequently Asked Questions</h2>
          <p className="text-lg text-gray-600">
            Everything you need to know about our AI coloring page generator
          </p>
        </div>
        
        <Tabs defaultValue="getting-started" className="w-full">
          <TabsList className="w-full justify-center mb-8 flex-wrap h-auto gap-2">
            <TabsTrigger value="getting-started">Getting Started</TabsTrigger>
            <TabsTrigger value="creating">Creating</TabsTrigger>
            <TabsTrigger value="downloading">Downloading</TabsTrigger>
            <TabsTrigger value="account">Account</TabsTrigger>
          </TabsList>
          
          {['getting-started', 'creating', 'downloading', 'account'].map((category) => (
            <TabsContent key={category} value={category}>
              <Accordion type="single" collapsible className="w-full">
                {faqs
                  .filter(faq => faq.category === category)
                  .map((faq, index) => (
                    <AccordionItem key={index} value={`item-${index}`} className="bg-white rounded-lg mb-2 border-0 shadow-sm">
                      <AccordionTrigger className="px-6 py-4 text-left font-medium hover:no-underline">
                        {faq.question}
                      </AccordionTrigger>
                      <AccordionContent className="px-6 pb-4 text-gray-600">
                        {faq.answer}
                      </AccordionContent>
                    </AccordionItem>
                  ))}
              </Accordion>
            </TabsContent>
          ))}
        </Tabs>
      </div>
    </section>
  );
}

// ==================== CTA ====================
function CTASection() {
  return (
    <section className="py-20 bg-gradient-to-r from-indigo-700 via-fuchsia-600 to-emerald-600">
      <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 text-center">
        <h2 className="text-3xl lg:text-5xl font-bold text-white mb-6">
          Ready to Create Your First Coloring Page?
        </h2>
        <p className="text-xl text-white/80 mb-8 max-w-2xl mx-auto">
          Join 320,000+ creators and start making beautiful coloring pages in seconds. 
          No credit card required.
        </p>
        <div className="flex flex-col sm:flex-row gap-4 justify-center">
          <Button className="bg-white text-indigo-700 hover:bg-gray-100 px-8 py-6 text-lg rounded-xl">
            <Sparkles className="w-5 h-5 mr-2" />
            Start Creating Free
          </Button>
          <Button variant="outline" className="border-2 border-white text-white hover:bg-white/10 px-8 py-6 text-lg rounded-xl">
            <Play className="w-5 h-5 mr-2" />
            Watch Demo
          </Button>
        </div>
        <div className="flex flex-wrap gap-6 justify-center mt-8 text-white/80">
          <span className="flex items-center gap-2">
            <Check className="w-5 h-5" />
            Free 7-day trial
          </span>
          <span className="flex items-center gap-2">
            <Check className="w-5 h-5" />
            No credit card
          </span>
          <span className="flex items-center gap-2">
            <Check className="w-5 h-5" />
            Cancel anytime
          </span>
        </div>
      </div>
    </section>
  );
}

// ==================== FOOTER ====================
function Footer() {
  const footerLinks = {
    'AI Generators': [
      'Photo to Coloring Page',
      'Text to Coloring Page',
      'Coloring Book Generator',
      'Colorize Drawing',
      'Line Art Converter'
    ],
    'Free Coloring Pages': [
      'Animals',
      'Cartoons',
      'Holidays',
      'Fantasy',
      'Nature',
      'View All'
    ],
    'Resources': [
      'Blog',
      'Tutorials',
      'Help Center',
      'Community',
      'API Docs'
    ],
    'Company': [
      'About Us',
      'Careers',
      'Contact',
      'Press Kit',
      'Partners'
    ]
  };

  return (
    <footer className="bg-gray-900 text-gray-300">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-16">
        <div className="grid md:grid-cols-2 lg:grid-cols-6 gap-12">
          {/* Brand */}
          <div className="lg:col-span-2">
            <a href="#" className="flex items-center gap-2 mb-6">
              <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-indigo-600 via-fuchsia-500 to-emerald-400 flex items-center justify-center">
                <Palette className="w-5 h-5 text-white" />
              </div>
              <span className="text-xl font-bold text-white">
                <span className="text-indigo-300">Ink</span>
                <span className="text-emerald-300">Bloom</span>
              </span>
            </a>
            <p className="text-gray-400 mb-6 leading-relaxed">
              AI-powered coloring page generator for creators, educators, and entrepreneurs. 
              Create unlimited designs in seconds.
            </p>
            
            {/* Newsletter */}
            <div className="mb-6">
              <h4 className="text-white font-medium mb-3">Subscribe to our newsletter</h4>
              <div className="flex gap-2">
                <Input 
                  placeholder="Enter your email"
                  className="bg-gray-800 border-gray-700 text-white"
                />
                <Button className="bg-gradient-to-r from-indigo-600 to-emerald-500 text-white">
                  <Mail className="w-4 h-4" />
                </Button>
              </div>
            </div>
            
            {/* Social Links */}
            <div className="flex gap-3">
              {[Facebook, Twitter, Instagram, Youtube, Linkedin].map((Icon, index) => (
                <a 
                  key={index}
                  href="#"
                  className="w-10 h-10 bg-gray-800 rounded-lg flex items-center justify-center hover:bg-gray-700 transition-colors"
                >
                  <Icon className="w-5 h-5" />
                </a>
              ))}
            </div>
          </div>
          
          {/* Links */}
          {Object.entries(footerLinks).map(([title, links]) => (
            <div key={title}>
              <h4 className="text-white font-semibold mb-4">{title}</h4>
              <ul className="space-y-3">
                {links.map((link, index) => (
                  <li key={index}>
                    <a href="#" className="text-gray-400 hover:text-white transition-colors">
                      {link}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
        
        <Separator className="my-12 bg-gray-800" />
        
        <div className="flex flex-col md:flex-row justify-between items-center gap-4">
          <p className="text-gray-500 text-sm">
            © 2026 InkBloom. All rights reserved.
          </p>
          <div className="flex gap-6 text-sm">
            <a href="#" className="text-gray-500 hover:text-white transition-colors">Privacy Policy</a>
            <a href="#" className="text-gray-500 hover:text-white transition-colors">Terms of Service</a>
            <a href="#" className="text-gray-500 hover:text-white transition-colors">Cookie Policy</a>
          </div>
        </div>
      </div>
    </footer>
  );
}

// ==================== MAIN APP ====================
function App() {
  const [user, setUser] = useState<User | null>(null)
  const [isSigningIn, setIsSigningIn] = useState(false)

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (u) => setUser(u))
    return () => unsub()
  }, [])

  useEffect(() => {
    const run = async () => {
      const sessionId = getOrCreateSessionId()
      try {
        await addDoc(collection(db, 'visits'), {
          createdAt: serverTimestamp(),
          uid: user?.uid ?? null,
          sessionId,
          path: `${window.location.pathname}${window.location.search}${window.location.hash}`,
          referrer: document.referrer || null,
          userAgent: navigator.userAgent,
        })
      } catch {
        return
      }
    }
    void run()
  }, [user?.uid])

  useEffect(() => {
    const run = async () => {
      if (!user) return
      try {
        await setDoc(
          doc(db, 'users', user.uid),
          {
            uid: user.uid,
            email: user.email ?? null,
            displayName: user.displayName ?? null,
            photoURL: user.photoURL ?? null,
            lastSignInAt: serverTimestamp(),
          },
          { merge: true }
        )
      } catch {
        return
      }
    }
    void run()
  }, [user])

  const handleSignIn = async () => {
    setIsSigningIn(true)
    try {
      await signInWithPopup(auth, googleProvider)
    } catch {
      return
    } finally {
      setIsSigningIn(false)
    }
  }

  const handleSignOut = async () => {
    try {
      await signOut(auth)
    } catch {
      return
    }
  }

  return (
    <div className="min-h-screen bg-white">
      <Header user={user} onSignIn={handleSignIn} onSignOut={handleSignOut} isSigningIn={isSigningIn} />
      <main>
        <HeroSection />
        <HowItWorksSection />
        <FeaturesGridSection />
        <PhotoToColoringSection />
        <TextToColoringSection />
        <ColoringBookSection />
        <ImageEditorSection />
        <ColorizeSection />
        <GallerySection />
        <OnlineColoringSection />
        <TestimonialsSection />
        <PricingSection />
        <FAQSection />
        <CTASection />
      </main>
      <Footer />
    </div>
  );
}

export default App;
