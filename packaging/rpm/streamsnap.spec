# Built by packaging/rpm/build.sh from the bundle tree (Electron included, no system Node.js needed).
%global debug_package %{nil}
%global _build_id_links none
%global __strip /bin/true
AutoReqProv: no
%global __requires_exclude ^lib.*\\.so.*$
%global __provides_exclude_from ^%{_libdir}/streamsnap/.*$

Name:           streamsnap
Version:        %{?pkg_version}%{!?pkg_version:0.2.0}
Release:        1%{?dist}
Summary:        Stream movies, series and live TV with Real-Debrid
License:        MIT
URL:            https://github.com/nbond3040/StreamSnap
Source0:        streamsnap-bundle.tar.gz
ExclusiveArch:  x86_64
Requires:       gtk3, nss, alsa-lib, libXScrnSaver, libXtst, at-spi2-core, xdg-utils
Recommends:     ffmpeg
Suggests:       mpv

%description
StreamSnap finds the best stream for every resolution in your language through
Torrentio and Real-Debrid, plays Live TV from an Xtream Codes provider with a
channel guide, and can download titles and record live channels for later.
Install ffmpeg (RPM Fusion's "ffmpeg") for format conversion, Live TV and DVR.

%prep
%setup -q -n streamsnap-bundle

%install
mkdir -p %{buildroot}%{_libdir}/streamsnap %{buildroot}%{_bindir} %{buildroot}%{_datadir}/applications %{buildroot}%{_datadir}/metainfo
cp -a streamsnap/. %{buildroot}%{_libdir}/streamsnap/
chmod 4755 %{buildroot}%{_libdir}/streamsnap/electron/chrome-sandbox   # Chromium's sandbox helper must be setuid root
ln -s %{_libdir}/streamsnap/streamsnap %{buildroot}%{_bindir}/streamsnap
install -Dm644 streamsnap.desktop %{buildroot}%{_datadir}/applications/streamsnap.desktop
install -Dm644 streamsnap.metainfo.xml %{buildroot}%{_datadir}/metainfo/io.github.nbond3040.StreamSnap.metainfo.xml
for n in 16 32 48 64 128 256 512; do
  install -Dm644 icons/$n.png %{buildroot}%{_datadir}/icons/hicolor/${n}x${n}/apps/streamsnap.png
done
install -Dm644 icon.svg %{buildroot}%{_datadir}/icons/hicolor/scalable/apps/streamsnap.svg

%files
%{_libdir}/streamsnap
%{_bindir}/streamsnap
%{_datadir}/applications/streamsnap.desktop
%{_datadir}/metainfo/io.github.nbond3040.StreamSnap.metainfo.xml
%{_datadir}/icons/hicolor/*/apps/streamsnap.*

%post
gtk-update-icon-cache -q %{_datadir}/icons/hicolor 2>/dev/null || :
update-desktop-database -q %{_datadir}/applications 2>/dev/null || :
