// Math coverage corpus, hand-written expressions (part A): school algebra to multivariable calculus,
// linear algebra and complex numbers, as they appear in lecture notes and homework.
// One expression per line: "<check> <latex>", check L = local-decidable, A = ai-only, D = display-only.
// build.mjs turns these into expressions.json.
const R = String.raw;

export const PART_A = {
  arithmetic: {
    'integers and order of operations': R`
L 17+25=42
L 144-89=55
L 12\times 13=156
L 7\cdot 8=56
L 96\div 8=12
L 3+4\cdot 5=23
L (3+4)\cdot 5=35
L 2^{10}=1024
L -3-(-7)=4
L (-2)^3=-8
L -2^4=-16
L 5!=120
L 0!=1
L 10-2\cdot 3+4=8
L 2\cdot(3+4)^2=98
L 1000-1=999
L 15\%\text{ of }80=12
L 4^{3/2}=8`,
    fractions: R`
L \frac{1}{2}+\frac{1}{3}=\frac{5}{6}
L \frac{3}{4}-\frac{1}{6}=\frac{7}{12}
L \frac{2}{3}\cdot\frac{9}{4}=\frac{3}{2}
L \frac{5}{8}\div\frac{1}{4}=\frac{5}{2}
L 2\frac{1}{2}=\frac{5}{2}
L \frac{12}{18}=\frac{2}{3}
L \frac{\frac{1}{2}}{\frac{3}{4}}=\frac{2}{3}
L 1-\frac{1}{1+\frac{1}{2}}=\frac{1}{3}
L \frac{7}{10}=0.7
L 0.125=\frac{1}{8}
L \frac{a}{b}+\frac{c}{d}=\frac{ad+bc}{bd}
L \frac{x}{3}+\frac{x}{6}=\frac{x}{2}`,
    'roots and powers': R`
L \sqrt{144}=12
L \sqrt{50}=5\sqrt{2}
L \sqrt[3]{27}=3
L \sqrt[4]{16}=2
L \sqrt{2}\cdot\sqrt{8}=4
L \frac{1}{\sqrt{2}}=\frac{\sqrt{2}}{2}
L \sqrt{12}+\sqrt{27}=5\sqrt{3}
L 8^{-1/3}=\frac{1}{2}
L 10^{-3}=0.001
L 2.5\times 10^{3}=2500
L \left(\frac{2}{3}\right)^{-2}=\frac{9}{4}`,
  },
  algebra: {
    'linear equations': R`
L 2x+3=7
L 2x=4
L x=2
L 3(x-2)=2x+5
L 3x-6=2x+5
L x=11
L \frac{x}{4}-1=\frac{x}{6}
L 3x-12=2x
L 5-2x\le 11
L -2x\le 6
L x\ge -3
L |2x-1|<5
L -2<x<3
L 0.2x+1.5=2.3
L \frac{2x+1}{3}=\frac{x-1}{2}`,
    'polynomials and factoring': R`
L (x+3)(x-3)=x^2-9
L (a+b)^2=a^2+2ab+b^2
L (a-b)^3=a^3-3a^2b+3ab^2-b^3
L x^2-5x+6=(x-2)(x-3)
L x^3-8=(x-2)(x^2+2x+4)
L 2x^2+7x+3=(2x+1)(x+3)
L x^4-1=(x-1)(x+1)(x^2+1)
L x^2+6x+5=(x+3)^2-4
L x=\frac{-b\pm\sqrt{b^2-4ac}}{2a}
L x=\frac{5\pm\sqrt{25-24}}{2}
L x_1=2,\quad x_2=3
L x_1+x_2=-\frac{b}{a}
L x_1x_2=\frac{c}{a}
L (x^2+2x)(x-1)=x^3+x^2-2x
L \frac{x^2-1}{x-1}=x+1
L \frac{x^3+1}{x+1}=x^2-x+1
L \frac{1}{x-1}-\frac{1}{x+1}=\frac{2}{x^2-1}
L \frac{3x+5}{(x+1)(x+2)}=\frac{2}{x+1}+\frac{1}{x+2}
L \frac{1}{x(x+1)}=\frac{1}{x}-\frac{1}{x+1}
L p(x)=x^3-2x^2-x+2
L p(1)=0
L \deg(pq)=\deg p+\deg q`,
    'exponents and logarithms': R`
L x^a\cdot x^b=x^{a+b}
L (x^a)^b=x^{ab}
L \frac{x^5}{x^2}=x^3
L \log_2 32=5
L \log_{10}0.01=-2
L \ln e^3=3
L \log(ab)=\log a+\log b
L \log_a x=\frac{\ln x}{\ln a}
L e^{\ln 5}=5
L 2^{x+1}=16
L x+1=4
L \ln(x^2)=2\ln|x|
L 3^{2x}-4\cdot 3^x+3=0
L \log_3 81-\log_3 9=2
L e^{2\ln 3}=9`,
    'systems and inequalities': R`
L \begin{cases}x+y=5\\x-y=1\end{cases}
L \begin{cases}2x+3y=12\\x-y=1\end{cases}
L \left\{\begin{aligned}x+2y-z&=3\\2x-y+z&=1\\x+y+z&=6\end{aligned}\right.
L x^2-4x+3<0
L 1<x<3
L \frac{x+1}{x-2}\ge 0
L x\le -1\ \text{or}\ x>2
L |x-3|\le 2
L 1\le x\le 5
L a^2+b^2\ge 2ab
L \frac{a+b}{2}\ge\sqrt{ab}`,
  },
  functions: {
    'functions and graphs': R`
D f:\mathbb{R}\to\mathbb{R},\ x\mapsto x^2
L f(x)=2x^2-3x+1
L f(-1)=6
L (f\circ g)(x)=f(g(x))
L f^{-1}(x)=\frac{x-3}{2}
D \operatorname{dom}f=\{x\in\mathbb{R}:x\ne 0\}
D f(x)=\begin{cases}x^2&x\ge 0\\-x&x<0\end{cases}
L |x|=\begin{cases}x&\text{if }x\ge 0\\-x&\text{if }x<0\end{cases}
L \lfloor 3.7\rfloor=3
L \lceil -2.1\rceil=-2
L \lfloor x\rfloor\le x<\lfloor x\rfloor+1
D y=mx+c
L m=\frac{y_2-y_1}{x_2-x_1}
L y-y_0=m(x-x_0)
L (x-a)^2+(y-b)^2=r^2
L \frac{x^2}{a^2}+\frac{y^2}{b^2}=1
L \frac{x^2}{9}-\frac{y^2}{16}=1
D f\ \text{is even}\iff f(-x)=f(x)
L \operatorname{sgn}(-3)=-1`,
    trigonometry: R`
L \sin^2x+\cos^2x=1
L \sin 2x=2\sin x\cos x
L \cos 2x=\cos^2x-\sin^2x
L \tan x=\frac{\sin x}{\cos x}
L \sin\frac{\pi}{6}=\frac{1}{2}
L \cos\frac{\pi}{4}=\frac{\sqrt{2}}{2}
L \tan\frac{\pi}{3}=\sqrt{3}
L \sin(\alpha+\beta)=\sin\alpha\cos\beta+\cos\alpha\sin\beta
L \cos(\alpha-\beta)=\cos\alpha\cos\beta+\sin\alpha\sin\beta
L 1+\tan^2\theta=\sec^2\theta
L \arcsin\frac{1}{2}=\frac{\pi}{6}
L \cosh^2x-\sinh^2x=1
L \sinh x=\frac{e^x-e^{-x}}{2}
L \tanh x=\frac{\sinh x}{\cosh x}
L c^2=a^2+b^2-2ab\cos\gamma
L \frac{a}{\sin\alpha}=\frac{b}{\sin\beta}
L 180^\circ=\pi\ \text{rad}
L \cos\theta=\frac{\vec{u}\cdot\vec{v}}{|\vec{u}||\vec{v}|}`,
  },
  analysis: {
    'sequences and limits': R`
L \lim_{n\to\infty}\frac{1}{n}=0
L \lim_{n\to\infty}\frac{3n^2+1}{n^2-n}=3
L \lim_{n\to\infty}\left(1+\frac{1}{n}\right)^n=e
L \lim_{n\to\infty}\sqrt[n]{n}=1
L \lim_{n\to\infty}\left(\sqrt{n+1}-\sqrt{n}\right)=0
A \forall\varepsilon>0\ \exists N\in\mathbb{N}\ \forall n\ge N:\ |a_n-a|<\varepsilon
A |a_n-a|\le\frac{1}{n}<\varepsilon
A n>\frac{1}{\varepsilon}
D (a_n)_{n\in\mathbb{N}}
A a_n\to a\ (n\to\infty)
A \limsup_{n\to\infty}a_n=\inf_{n\ge 1}\sup_{k\ge n}a_k
A \liminf_{n\to\infty}a_n\le\limsup_{n\to\infty}a_n
A (a_{n_k})_{k\in\mathbb{N}}\ \text{converges}
A |a_n-a_m|<\varepsilon\quad\forall n,m\ge N
A a_{n+1}\le a_n
L a_n=\frac{(-1)^n}{n}
L a_{n+1}=\frac{1}{2}\left(a_n+\frac{2}{a_n}\right)
A \sup S=\min\{b:b\ \text{upper bound of}\ S\}
A \sup_{x\in[0,1)}x=1
A \inf\left\{\frac{1}{n}:n\in\mathbb{N}\right\}=0`,
    'series and convergence': R`
L \sum_{n=1}^{\infty}\frac{1}{2^n}=1
L \sum_{n=0}^{\infty}x^n=\frac{1}{1-x}
A \sum_{n=1}^{\infty}\frac{1}{n^2}<\infty
L \sum_{n=1}^{\infty}\frac{1}{n^2}=\frac{\pi^2}{6}
A \sum_{n=1}^{\infty}\frac{1}{n}=\infty
A \lim_{n\to\infty}\left|\frac{a_{n+1}}{a_n}\right|=L<1
A \limsup_{n\to\infty}\sqrt[n]{|a_n|}<1
A \sum_{n=1}^{\infty}\frac{(-1)^{n+1}}{n}=\ln 2
A \left|\frac{a_{n+1}}{a_n}\right|=\frac{n+1}{3n}\to\frac{1}{3}
A R=\frac{1}{\limsup_{n\to\infty}\sqrt[n]{|c_n|}}
L e^x=\sum_{n=0}^{\infty}\frac{x^n}{n!}
L \sin x=\sum_{n=0}^{\infty}\frac{(-1)^nx^{2n+1}}{(2n+1)!}
A \sum_{k=1}^{n}\frac{1}{k(k+1)}=1-\frac{1}{n+1}
A 0\le a_n\le b_n,\ \sum b_n<\infty\implies\sum a_n<\infty
A \int_1^{\infty}\frac{dx}{x^p}<\infty\iff p>1
A \sum_{n=1}^{\infty}a_n\ \text{converges absolutely}`,
    'continuity and differentiability': R`
A \forall\varepsilon>0\ \exists\delta>0:\ |x-x_0|<\delta\implies|f(x)-f(x_0)|<\varepsilon
A |f(x)-f(y)|\le L|x-y|
A \delta=\min\left\{1,\frac{\varepsilon}{7}\right\}
A |x^2-4|=|x-2||x+2|<5\delta
A \lim_{x\to x_0}f(x)=f(x_0)
A f(c)=\frac{f(b)-f(a)}{b-a}
A f'(\xi)=\frac{f(b)-f(a)}{b-a},\ \xi\in(a,b)
L f(x)=\sum_{k=0}^{n}\frac{f^{(k)}(a)}{k!}(x-a)^k+R_n(x)
A R_n(x)=\frac{f^{(n+1)}(\xi)}{(n+1)!}(x-a)^{n+1}
A \lim_{x\to 0^+}x\ln x=0
A f\in C^1([a,b])
A f_n\rightrightarrows f
A \sup_{x\in[0,1]}|f_n(x)-f(x)|\to 0
A \|f\|_\infty=\sup_{x\in X}|f(x)|`,
  },
  calculus: {
    derivatives: R`
L \frac{d}{dx}x^n=nx^{n-1}
L \frac{d}{dx}\left(x^3\sin x\right)=3x^2\sin x+x^3\cos x
L \frac{d}{dx}e^{3x}=3e^{3x}
L \frac{d}{dx}\ln(x^2+1)=\frac{2x}{x^2+1}
L \left(\frac{u}{v}\right)'=\frac{u'v-uv'}{v^2}
L (fg)'=f'g+fg'
L \frac{dy}{dx}=\frac{dy}{du}\cdot\frac{du}{dx}
L f'(x)=\lim_{h\to 0}\frac{f(x+h)-f(x)}{h}
L f(x)=\sqrt{1-x^2}
L f'(x)=\frac{-x}{\sqrt{1-x^2}}
L y'=2xe^{x^2}
L f''(x)=6x-4
L \frac{d^2y}{dx^2}=-\sin x
L \frac{d}{dx}\arctan x=\frac{1}{1+x^2}
L \frac{d}{dx}a^x=a^x\ln a
L \frac{d}{dx}\tan x=\sec^2x
L f^{(4)}(x)=24
L \dot{x}(t)=v_0-gt
L \ddot{x}=-\omega^2x
L x^2+y^2=1\implies 2x+2yy'=0
L \frac{d}{dx}x^x=x^x(\ln x+1)`,
    integrals: R`
L \int x^2\,dx=\frac{x^3}{3}+C
L \int_0^1x^2\,dx=\frac{1}{3}
L \int_0^{\pi}\sin x\,dx=2
L \int\frac{1}{x}\,dx=\ln|x|+C
L \int e^{2x}\,dx=\frac{1}{2}e^{2x}+C
L \int x e^x\,dx=xe^x-e^x+C
L \int u\,dv=uv-\int v\,du
L \int_1^e\ln x\,dx=1
L \int\frac{dx}{1+x^2}=\arctan x+C
L \int_{-\infty}^{\infty}e^{-x^2}\,dx=\sqrt{\pi}
L \int_0^{\infty}e^{-x}\,dx=1
L \int\frac{2x}{x^2+1}\,dx=\ln(x^2+1)+C
L \int_0^{2}\left(3x^2-2x\right)dx=4
L \int\sin^2x\,dx=\frac{x}{2}-\frac{\sin 2x}{4}+C
L \left[\frac{x^3}{3}\right]_0^2=\frac{8}{3}
L F(b)-F(a)=\int_a^bf(x)\,dx
L \frac{d}{dx}\int_a^xf(t)\,dt=f(x)
L u=x^2,\ du=2x\,dx
L \int_0^1\frac{dx}{\sqrt{1-x^2}}=\frac{\pi}{2}
L A=\int_a^b|f(x)-g(x)|\,dx
L V=\pi\int_0^1x^4\,dx=\frac{\pi}{5}
L \Gamma(n)=(n-1)!
D \Gamma(s)=\int_0^{\infty}t^{s-1}e^{-t}\,dt`,
    'limits (calculus)': R`
L \lim_{x\to 0}\frac{\sin x}{x}=1
L \lim_{x\to 2}\frac{x^2-4}{x-2}=4
L \lim_{x\to\infty}\frac{2x^2+1}{x^2-3}=2
L \lim_{x\to 0}\frac{e^x-1}{x}=1
L \lim_{x\to 0}\frac{1-\cos x}{x^2}=\frac{1}{2}
L \lim_{x\to 0^+}\frac{1}{x}=+\infty
L \lim_{x\to 0}\frac{\sin 3x}{x}=3
L \lim_{x\to\infty}xe^{-x}=0
L \lim_{x\to 1}\frac{\ln x}{x-1}=1
L \lim_{x\to a}\frac{f(x)}{g(x)}=\lim_{x\to a}\frac{f'(x)}{g'(x)}`,
  },
  multivar: {
    'partial derivatives and gradients': R`
L f(x,y)=x^2y+\sin(xy)
L \frac{\partial f}{\partial x}=2xy+y\cos(xy)
L \frac{\partial^2f}{\partial x\,\partial y}=\frac{\partial^2f}{\partial y\,\partial x}
L f_{xy}=f_{yx}
L \nabla f=\left(\frac{\partial f}{\partial x},\frac{\partial f}{\partial y},\frac{\partial f}{\partial z}\right)
L \nabla f(1,2)=(4,1)
L D_{\vec{u}}f=\nabla f\cdot\vec{u}
L \frac{\partial}{\partial x}\left(x^2y^3\right)=2xy^3
L \frac{\partial}{\partial y}\left(x^2y^3\right)=3x^2y^2
L \frac{dz}{dt}=\frac{\partial z}{\partial x}\frac{dx}{dt}+\frac{\partial z}{\partial y}\frac{dy}{dt}
L J=\begin{pmatrix}\frac{\partial u}{\partial x}&\frac{\partial u}{\partial y}\\\frac{\partial v}{\partial x}&\frac{\partial v}{\partial y}\end{pmatrix}
L \det J=r
L \frac{\partial(x,y)}{\partial(r,\theta)}=r
L H_f=\begin{pmatrix}f_{xx}&f_{xy}\\f_{yx}&f_{yy}\end{pmatrix}
L \nabla^2u=\frac{\partial^2u}{\partial x^2}+\frac{\partial^2u}{\partial y^2}
L \Delta u=0
A \nabla f=\lambda\nabla g
D \mathcal{L}(x,y,\lambda)=f(x,y)-\lambda g(x,y)
L f(x+h)\approx f(x)+\nabla f(x)\cdot h+\frac{1}{2}h^THh`,
    'multiple integrals': R`
L \iint_D xy\,dA=\int_0^1\int_0^2xy\,dy\,dx
L \int_0^1\int_0^2xy\,dy\,dx=1
L \iint_{x^2+y^2\le 1}dA=\pi
L \int_0^{2\pi}\int_0^1r\,dr\,d\theta=\pi
L \iiint_V dV=\frac{4}{3}\pi r^3
L dx\,dy=r\,dr\,d\theta
L dV=r^2\sin\theta\,dr\,d\theta\,d\varphi
L \int_0^{\pi}\int_0^{2\pi}\int_0^R r^2\sin\theta\,dr\,d\varphi\,d\theta=\frac{4\pi R^3}{3}
L \iint_D(x+y)\,dx\,dy=\int_0^1\int_0^{1-x}(x+y)\,dy\,dx`,
    'vector calculus': R`
L \nabla\cdot\vec{F}=\frac{\partial F_1}{\partial x}+\frac{\partial F_2}{\partial y}+\frac{\partial F_3}{\partial z}
L \nabla\times\vec{F}=\begin{vmatrix}\vec{i}&\vec{j}&\vec{k}\\\partial_x&\partial_y&\partial_z\\F_1&F_2&F_3\end{vmatrix}
L \operatorname{div}\vec{F}=2x+2y+2z
L \operatorname{curl}(\nabla f)=\vec{0}
L \nabla\cdot(\nabla\times\vec{F})=0
L \int_C\vec{F}\cdot d\vec{r}=\int_a^b\vec{F}(\vec{r}(t))\cdot\vec{r}\,'(t)\,dt
L \oint_C\vec{F}\cdot d\vec{r}=\iint_S(\nabla\times\vec{F})\cdot d\vec{S}
L \oiint_S\vec{F}\cdot d\vec{S}=\iiint_V\nabla\cdot\vec{F}\,dV
L \oint_C(P\,dx+Q\,dy)=\iint_D\left(\frac{\partial Q}{\partial x}-\frac{\partial P}{\partial y}\right)dA
L \vec{r}(t)=(\cos t,\sin t,t)
L |\vec{r}\,'(t)|=\sqrt{2}
L \vec{n}=\frac{\vec{r}_u\times\vec{r}_v}{\|\vec{r}_u\times\vec{r}_v\|}
L \iint_S f\,dS=\iint_D f(\vec{r}(u,v))\|\vec{r}_u\times\vec{r}_v\|\,du\,dv
L \vec{u}\times\vec{v}=(u_2v_3-u_3v_2,\ u_3v_1-u_1v_3,\ u_1v_2-u_2v_1)
L \vec{a}\cdot(\vec{b}\times\vec{c})=\det(\vec{a},\vec{b},\vec{c})`,
  },
  linalg: {
    'vectors and matrices': R`
L \begin{pmatrix}1\\2\\3\end{pmatrix}+\begin{pmatrix}4\\5\\6\end{pmatrix}=\begin{pmatrix}5\\7\\9\end{pmatrix}
L \begin{pmatrix}1&2\\3&4\end{pmatrix}\begin{pmatrix}5&6\\7&8\end{pmatrix}=\begin{pmatrix}19&22\\43&50\end{pmatrix}
L \begin{bmatrix}2&0\\1&3\end{bmatrix}\begin{bmatrix}x\\y\end{bmatrix}=\begin{bmatrix}4\\7\end{bmatrix}
L A^T=\begin{pmatrix}1&3\\2&4\end{pmatrix}
L (AB)^T=B^TA^T
L (AB)^{-1}=B^{-1}A^{-1}
L \vec{u}\cdot\vec{v}=u_1v_1+u_2v_2+u_3v_3
L \|\vec{v}\|=\sqrt{v_1^2+v_2^2+v_3^2}
L \langle u,v\rangle=\sum_{i=1}^{n}u_iv_i
L \operatorname{tr}(A)=\sum_{i=1}^{n}a_{ii}
L (AB)_{ij}=\sum_{k=1}^{n}a_{ik}b_{kj}
L I_3=\begin{pmatrix}1&0&0\\0&1&0\\0&0&1\end{pmatrix}
L A=\begin{pmatrix}a_{11}&\cdots&a_{1n}\\\vdots&\ddots&\vdots\\a_{m1}&\cdots&a_{mn}\end{pmatrix}
L \operatorname{proj}_{\vec{v}}\vec{u}=\frac{\vec{u}\cdot\vec{v}}{\vec{v}\cdot\vec{v}}\vec{v}`,
    'determinants and inverses': R`
L \begin{vmatrix}a&b\\c&d\end{vmatrix}=ad-bc
L \det\begin{pmatrix}2&1\\5&3\end{pmatrix}=1
L \begin{vmatrix}1&2&3\\0&1&4\\5&6&0\end{vmatrix}=1
L \det(AB)=\det A\det B
L \det(A^{-1})=\frac{1}{\det A}
L \det(\lambda A)=\lambda^n\det A
L \begin{pmatrix}a&b\\c&d\end{pmatrix}^{-1}=\frac{1}{ad-bc}\begin{pmatrix}d&-b\\-c&a\end{pmatrix}
L \begin{pmatrix}2&1\\5&3\end{pmatrix}^{-1}=\begin{pmatrix}3&-1\\-5&2\end{pmatrix}
L AA^{-1}=I
L A^{-1}=\frac{1}{\det A}\operatorname{adj}(A)
L \det A=\sum_{\sigma\in S_n}\operatorname{sgn}(\sigma)\prod_{i=1}^{n}a_{i\sigma(i)}
L \left(\begin{array}{cc|c}1&2&5\\3&4&6\end{array}\right)
L \left(\begin{array}{ccc|c}1&1&1&6\\0&1&2&8\\0&0&1&3\end{array}\right)
L \left(\begin{array}{cc|cc}1&2&1&0\\3&4&0&1\end{array}\right)
L R_2\to R_2-3R_1
L \operatorname{rank}A=2`,
    'eigenvalues and spaces': R`
L A\vec{v}=\lambda\vec{v}
L \det(A-\lambda I)=0
L \begin{vmatrix}2-\lambda&1\\1&2-\lambda\end{vmatrix}=(2-\lambda)^2-1
L \lambda_1=1,\ \lambda_2=3
L \begin{pmatrix}2&1\\1&2\end{pmatrix}\begin{pmatrix}1\\1\end{pmatrix}=3\begin{pmatrix}1\\1\end{pmatrix}
L A=PDP^{-1}
L D=\begin{pmatrix}\lambda_1&0\\0&\lambda_2\end{pmatrix}
L A^n=PD^nP^{-1}
L \chi_A(\lambda)=\lambda^2-\operatorname{tr}(A)\lambda+\det A
A \dim V=\dim\ker T+\dim\operatorname{im}T
D \ker T=\{v\in V:T(v)=0\}
D \operatorname{span}\{v_1,\dots,v_k\}
A \alpha_1v_1+\dots+\alpha_nv_n=0\implies\alpha_1=\dots=\alpha_n=0
D V=U\oplus W
D V\otimes W
L \dim(V\otimes W)=\dim V\cdot\dim W
D \langle\cdot,\cdot\rangle:V\times V\to\mathbb{R}
A |\langle u,v\rangle|\le\|u\|\|v\|
A \|u+v\|\le\|u\|+\|v\|
L u_2=v_2-\frac{\langle v_2,u_1\rangle}{\langle u_1,u_1\rangle}u_1
A U^\dagger U=I
D A^*=\bar{A}^T
A A=A^T\implies\sigma(A)\subset\mathbb{R}
D \hat{e}_1,\hat{e}_2,\hat{e}_3
L \|x\|_1=\sum_{i=1}^{n}|x_i|
L \|A\|_F=\sqrt{\sum_{i,j}|a_{ij}|^2}
D V^*=\operatorname{Hom}(V,\mathbb{F})
D T:V\to W\ \text{linear}`,
  },
  complex: {
    'complex numbers': R`
L i^2=-1
L (2+3i)(1-i)=5+i
L \frac{1+i}{1-i}=i
L |3+4i|=5
L \overline{z}=x-iy
L z\bar{z}=|z|^2
L e^{i\theta}=\cos\theta+i\sin\theta
L e^{i\pi}+1=0
L z=re^{i\varphi}
L (\cos\theta+i\sin\theta)^n=\cos n\theta+i\sin n\theta
L z^3=1\iff z\in\left\{1,e^{2\pi i/3},e^{4\pi i/3}\right\}
L \operatorname{Re}(z)=\frac{z+\bar{z}}{2}
L \operatorname{Im}(z)=\frac{z-\bar{z}}{2i}
L \arg(1+i)=\frac{\pi}{4}
L \sqrt{-4}=2i
L \cos z=\frac{e^{iz}+e^{-iz}}{2}`,
    'complex analysis': R`
A \frac{\partial u}{\partial x}=\frac{\partial v}{\partial y},\quad\frac{\partial u}{\partial y}=-\frac{\partial v}{\partial x}
L f'(z)=\lim_{h\to 0}\frac{f(z+h)-f(z)}{h}
A \oint_{\gamma}f(z)\,dz=0
L \oint_{|z|=1}\frac{dz}{z}=2\pi i
A f(a)=\frac{1}{2\pi i}\oint_{\gamma}\frac{f(z)}{z-a}\,dz
A f^{(n)}(a)=\frac{n!}{2\pi i}\oint_{\gamma}\frac{f(z)}{(z-a)^{n+1}}\,dz
L \operatorname{Res}_{z=0}\frac{e^z}{z^3}=\frac{1}{2}
L \operatorname{Res}_{z=i}\frac{1}{z^2+1}=\frac{1}{2i}
A \oint_{\gamma}f(z)\,dz=2\pi i\sum_k\operatorname{Res}(f,z_k)
L \int_{-\infty}^{\infty}\frac{dx}{1+x^2}=\pi
L \int_0^{2\pi}\frac{d\theta}{2+\cos\theta}=\frac{2\pi}{\sqrt{3}}
L \frac{1}{1-z}=\sum_{n=0}^{\infty}z^n,\quad|z|<1
L f(z)=\sum_{n=-\infty}^{\infty}a_n(z-z_0)^n
A \operatorname{Res}_{z=z_0}f=\lim_{z\to z_0}(z-z_0)f(z)
L \operatorname{Log}z=\ln|z|+i\operatorname{Arg}z
A |f(z)|\le M\ \forall z\in\mathbb{C}\implies f\ \text{constant}
A \left|\int_{\gamma}f(z)\,dz\right|\le ML(\gamma)
D \mathbb{D}=\{z\in\mathbb{C}:|z|<1\}
D \hat{\mathbb{C}}=\mathbb{C}\cup\{\infty\}
L w=\frac{az+b}{cz+d},\quad ad-bc\ne 0`,
  },
};
