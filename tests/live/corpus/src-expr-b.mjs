// Math coverage corpus, hand-written expressions (part B): differential equations, algebra, number
// theory, discrete maths, logic and sets, probability and statistics, topology, measure theory,
// functional analysis, numerics and differential geometry. Same line format as src-expr-a.mjs.
const R = String.raw;

export const PART_B = {
  ode: {
    'ordinary differential equations': R`
L y'=ky
L y=Ce^{kx}
L y''+\omega^2y=0
L y=A\cos\omega x+B\sin\omega x
L y''-5y'+6y=0
L y=C_1e^{2x}+C_2e^{3x}
L \lambda^2-5\lambda+6=0
L y''+2y'+y=0
L y=(C_1+C_2x)e^{-x}
L y'+\frac{2}{x}y=x
L \mu(x)=e^{\int P(x)\,dx}
L \frac{dy}{dx}=\frac{x}{y}
L y\,dy=x\,dx
L y^2-x^2=C
L \dot{x}=-2x,\ x(0)=3
L x(t)=3e^{-2t}
L y_p=Ax^2+Bx+C
D \vec{x}\,'=A\vec{x}
L \vec{x}(t)=e^{At}\vec{x}_0
L W(y_1,y_2)=\begin{vmatrix}y_1&y_2\\y_1'&y_2'\end{vmatrix}
L \mathcal{L}\{f(t)\}=\int_0^{\infty}e^{-st}f(t)\,dt
L \mathcal{L}\{e^{at}\}=\frac{1}{s-a}
L \mathcal{L}\{y'\}=sY(s)-y(0)
A |f(t,y_1)-f(t,y_2)|\le L|y_1-y_2|
L \frac{d}{dt}\begin{pmatrix}x\\y\end{pmatrix}=\begin{pmatrix}0&1\\-1&0\end{pmatrix}\begin{pmatrix}x\\y\end{pmatrix}
L x^2y''+xy'+(x^2-\nu^2)y=0`,
  },
  pde: {
    'partial differential equations': R`
D u_t=\alpha u_{xx}
D u_{tt}=c^2u_{xx}
D \frac{\partial^2u}{\partial t^2}=c^2\nabla^2u
D \Delta u=f\ \text{in}\ \Omega,\quad u=0\ \text{on}\ \partial\Omega
L u(x,t)=f(x-ct)+g(x+ct)
L u(x,t)=X(x)T(t)
L \frac{T'}{\alpha T}=\frac{X''}{X}=-\lambda
L u(x,t)=\sum_{n=1}^{\infty}b_ne^{-\alpha n^2\pi^2t/L^2}\sin\frac{n\pi x}{L}
L b_n=\frac{2}{L}\int_0^Lf(x)\sin\frac{n\pi x}{L}\,dx
L f(x)=\frac{a_0}{2}+\sum_{n=1}^{\infty}\left(a_n\cos nx+b_n\sin nx\right)
L \hat{f}(\xi)=\int_{-\infty}^{\infty}f(x)e^{-2\pi ix\xi}\,dx
L u(x,t)=\frac{1}{\sqrt{4\pi t}}\int_{-\infty}^{\infty}e^{-\frac{(x-y)^2}{4t}}g(y)\,dy
L u_t+cu_x=0
D \Phi(x)=-\frac{1}{2\pi}\ln|x|
A \int_{\Omega}\nabla u\cdot\nabla v\,dx=\int_{\Omega}fv\,dx\quad\forall v\in H_0^1(\Omega)
D \frac{\partial u}{\partial n}=0\ \text{on}\ \partial\Omega`,
  },
  'abstract-algebra': {
    groups: R`
D (G,\cdot)
A H\le G
A N\trianglelefteq G
A N\lhd G
A G/N\cong\operatorname{im}\varphi
A \varphi:G\to H\ \text{homomorphism}
A \varphi(gh)=\varphi(g)\varphi(h)
D \ker\varphi=\{g\in G:\varphi(g)=e\}
A |G|=[G:H]\,|H|
L |S_n|=n!
L |D_{2n}|=2n
L \mathbb{Z}/6\mathbb{Z}\cong\mathbb{Z}/2\mathbb{Z}\times\mathbb{Z}/3\mathbb{Z}
D gHg^{-1}=H
L \sigma=(1\,2\,3)(4\,5)
L \operatorname{ord}(\sigma)=6
L (1\,2\,3)^{-1}=(1\,3\,2)
L \operatorname{sgn}(\sigma)=(-1)^{k}
A a^{|G|}=e
D \langle g\rangle=\{g^n:n\in\mathbb{Z}\}
D Z(G)=\{z\in G:zg=gz\ \forall g\in G\}
A |G|=|Z(G)|+\sum_i[G:C_G(g_i)]
A |\operatorname{Orb}(x)|\cdot|\operatorname{Stab}(x)|=|G|
D \operatorname{Aut}(G)
D G\curvearrowright X
D 1\to N\to G\to G/N\to 1
A n_p\equiv 1\pmod p`,
    'rings, fields and modules': R`
D (R,+,\cdot)
D I\subseteq R\ \text{ideal}
A R/I\ \text{field}\iff I\ \text{maximal}
L \mathbb{Z}[i]=\{a+bi:a,b\in\mathbb{Z}\}
D \mathbb{F}_p=\mathbb{Z}/p\mathbb{Z}
L |\mathbb{F}_{p^n}|=p^n
A [L:K]=[L:M][M:K]
L [\mathbb{Q}(\sqrt{2}):\mathbb{Q}]=2
L \mathbb{Q}(\sqrt[3]{2},\omega)
A \operatorname{Gal}(L/K)\cong S_3
D \mathbb{R}[x]/(x^2+1)\cong\mathbb{C}
D \mathfrak{p}\subset\mathcal{O}_K
D \mathfrak{m}=(x,y)
L x^4+1=(x^2+\sqrt{2}x+1)(x^2-\sqrt{2}x+1)
A \gcd(f,f')=1\implies f\ \text{separable}
D M\otimes_RN
D \operatorname{Hom}_R(M,N)
D \operatorname{char}K=p
A \Phi_n(x)=\prod_{\gcd(k,n)=1}\left(x-e^{2\pi ik/n}\right)
D R^\times`,
  },
  'number-theory': {
    'divisibility and congruences': R`
L 17\equiv 2\pmod{5}
L 3^{100}\equiv 1\pmod{7}
L 2^{10}\equiv 1\pmod{11}
L a^{p-1}\equiv 1\pmod p
L a^{\varphi(n)}\equiv 1\pmod n
L \varphi(12)=4
L \varphi(p^k)=p^k-p^{k-1}
L \gcd(84,36)=12
L \operatorname{lcm}(4,6)=12
L 84=2\cdot 36+12
L 36=3\cdot 12+0
L 12=84-2\cdot 36
L 1=5\cdot 11-6\cdot 9
L 7x\equiv 1\pmod{26}
L x\equiv 15\pmod{26}
L 3\mid 12
L 5\nmid 12
L \left(\frac{2}{7}\right)=1
L \left(\frac{a}{p}\right)\equiv a^{\frac{p-1}{2}}\pmod p
A \left(\frac{p}{q}\right)\left(\frac{q}{p}\right)=(-1)^{\frac{p-1}{2}\cdot\frac{q-1}{2}}
L \begin{cases}x\equiv 2\pmod 3\\x\equiv 3\pmod 5\end{cases}
L x\equiv 8\pmod{15}
L 360=2^3\cdot 3^2\cdot 5
L \sigma(6)=12
L \tau(12)=6
L 13\cdot 17\bmod 10=1
A \pi(x)\sim\frac{x}{\ln x}
A p\mid ab\implies p\mid a\ \text{or}\ p\mid b
L \mathbb{Z}/7\mathbb{Z}^\times=\langle 3\rangle
L \sum_{d\mid n}\varphi(d)=n
L \mu(30)=-1
L x^2-2y^2=1`,
  },
  discrete: {
    'combinatorics': R`
L \binom{5}{2}=10
L \binom{n}{k}=\frac{n!}{k!(n-k)!}
L \binom{n}{k}=\binom{n-1}{k-1}+\binom{n-1}{k}
L (a+b)^n=\sum_{k=0}^{n}\binom{n}{k}a^kb^{n-k}
L \sum_{k=0}^{n}\binom{n}{k}=2^n
L \binom{10}{3}=120
L P(n,k)=\frac{n!}{(n-k)!}
L \binom{n+k-1}{k}
L |A\cup B|=|A|+|B|-|A\cap B|
L S(n,2)=2^{n-1}-1
L D_n=n!\sum_{k=0}^{n}\frac{(-1)^k}{k!}
L C_n=\frac{1}{n+1}\binom{2n}{n}
L \sum_{k=1}^{n}k=\frac{n(n+1)}{2}
L \sum_{k=1}^{n}k^2=\frac{n(n+1)(2n+1)}{6}
L \sum_{k=0}^{n-1}r^k=\frac{r^n-1}{r-1}
L \prod_{k=1}^{n}k=n!
L n!\approx\sqrt{2\pi n}\left(\frac{n}{e}\right)^n`,
    'recurrences and generating functions': R`
L F_{n+1}=F_n+F_{n-1}
L F_n=\frac{\varphi^n-\psi^n}{\sqrt{5}}
L a_n=2a_{n-1}+1,\ a_0=0
L a_n=2^n-1
L G(x)=\sum_{n=0}^{\infty}a_nx^n
L \sum_{n=0}^{\infty}F_nx^n=\frac{x}{1-x-x^2}
L T(n)=2T\left(\frac{n}{2}\right)+n
L T(n)=\Theta(n\log n)
L f(n)=O(n^2)
L r^2-r-1=0`,
    'graphs': R`
D G=(V,E)
L \sum_{v\in V}\deg(v)=2|E|
L |E|=\binom{n}{2}
L |E(K_n)|=\frac{n(n-1)}{2}
L V-E+F=2
L \chi(K_n)=n
A |E|\le 3|V|-6
D \delta(G)\ge\frac{n}{2}
D A_{ij}=\begin{cases}1&\{i,j\}\in E\\0&\text{otherwise}\end{cases}
L n^{n-2}
D d(u,v)=\min\{|P|:P\ \text{a}\ u\text{-}v\ \text{path}\}`,
  },
  'logic-sets': {
    'propositional and predicate logic': R`
L \neg(p\land q)\equiv\neg p\lor\neg q
L \neg(p\lor q)\equiv\neg p\land\neg q
L p\Rightarrow q\equiv\neg p\lor q
L (p\Rightarrow q)\equiv(\neg q\Rightarrow\neg p)
L p\Leftrightarrow q\equiv(p\Rightarrow q)\land(q\Rightarrow p)
L p\lor\neg p
L ((p\Rightarrow q)\land p)\Rightarrow q
A \neg\forall x\,P(x)\iff\exists x\,\neg P(x)
A \neg\exists x\,P(x)\iff\forall x\,\neg P(x)
A \forall x\in A\ \exists y\in B:\ f(x)=y
A \exists!\,x:\ P(x)
A \Gamma\vdash\varphi
A \Gamma\models\varphi
A \vdash\varphi\to(\psi\to\varphi)
D \mathcal{M}\models\forall x\,\exists y\,(x<y)
A \frac{\varphi\quad\varphi\to\psi}{\psi}
D \top,\ \bot`,
    'sets and functions': R`
D A=\{x\in\mathbb{Z}:x^2<10\}
L A\cup B=\{1,2,3,4\}
L A\cap B=\{2\}
L A\setminus B=\{1,3\}
L A\triangle B=(A\setminus B)\cup(B\setminus A)
L \overline{A\cup B}=\bar{A}\cap\bar{B}
L (A\cup B)^c=A^c\cap B^c
L A\setminus(B\cup C)=(A\setminus B)\cap(A\setminus C)
L A\cap(B\cup C)=(A\cap B)\cup(A\cap C)
L \mathcal{P}(\{1,2\})=\{\emptyset,\{1\},\{2\},\{1,2\}\}
L |\mathcal{P}(A)|=2^{|A|}
L A\times B=\{(a,b):a\in A,\ b\in B\}
L |A\times B|=|A|\cdot|B|
A A\subseteq B\iff A\cap B=A
A x\in A\cap B\implies x\in A
A \bigcup_{i\in I}A_i=\{x:\exists i\in I,\ x\in A_i\}
A \bigcap_{n=1}^{\infty}\left(0,\frac{1}{n}\right)=\emptyset
A |\mathbb{N}|=|\mathbb{Q}|=\aleph_0
A |\mathbb{R}|=2^{\aleph_0}
A |\mathcal{P}(X)|>|X|
A f\ \text{injective}\iff\forall x,y:\ f(x)=f(y)\Rightarrow x=y
D f^{-1}(B)=\{x\in X:f(x)\in B\}
A f(A\cap B)\subseteq f(A)\cap f(B)
D x\sim y\iff x-y\in\mathbb{Z}
D [x]=\{y\in X:y\sim x\}
D X/{\sim}
D \omega+1,\ \omega\cdot 2,\ \omega^\omega
A \aleph_1\le 2^{\aleph_0}
D (\mathbb{N},\le)\ \text{is well-ordered}
D \emptyset\notin\mathcal{F}`,
  },
  probability: {
    'events and random variables': R`
L P(A\cup B)=P(A)+P(B)-P(A\cap B)
L P(A\mid B)=\frac{P(A\cap B)}{P(B)}
L P(A\mid B)=\frac{P(B\mid A)P(A)}{P(B)}
L P(B)=\sum_{i}P(B\mid A_i)P(A_i)
L P(A^c)=1-P(A)
L P(X=k)=\binom{n}{k}p^k(1-p)^{n-k}
L P(X=k)=\frac{\lambda^ke^{-\lambda}}{k!}
L X\sim\mathcal{N}(\mu,\sigma^2)
D X\sim\operatorname{Bin}(n,p)
D X\sim\operatorname{Exp}(\lambda)
L f_X(x)=\frac{1}{\sigma\sqrt{2\pi}}e^{-\frac{(x-\mu)^2}{2\sigma^2}}
L \int_{-\infty}^{\infty}f_X(x)\,dx=1
L F_X(x)=P(X\le x)
L E[X]=\sum_xx\,P(X=x)
L E[X]=\int_{-\infty}^{\infty}xf(x)\,dx
L \operatorname{Var}(X)=E[X^2]-(E[X])^2
L \operatorname{Var}(aX+b)=a^2\operatorname{Var}(X)
L \operatorname{Cov}(X,Y)=E[XY]-E[X]E[Y]
L E[X+Y]=E[X]+E[Y]
L \mathbb{E}[X]=np
L \operatorname{Var}(X)=np(1-p)
L E[e^{tX}]=e^{\mu t+\frac{1}{2}\sigma^2t^2}
L P(X>s+t\mid X>s)=P(X>t)
A P(|X-\mu|\ge k\sigma)\le\frac{1}{k^2}
A \frac{1}{n}\sum_{i=1}^{n}X_i\xrightarrow{\text{a.s.}}\mu
A \frac{S_n-n\mu}{\sigma\sqrt{n}}\xrightarrow{d}\mathcal{N}(0,1)
L P(X=1)=\frac{1}{6}
L E[X]=\frac{7}{2}
L \varphi_X(t)=E\left[e^{itX}\right]
L p_{ij}=P(X_{n+1}=j\mid X_n=i)
L \pi P=\pi
A E[X\mid\mathcal{F}_n]=X_n`,
  },
  statistics: {
    'estimation and testing': R`
L \bar{x}=\frac{1}{n}\sum_{i=1}^{n}x_i
L s^2=\frac{1}{n-1}\sum_{i=1}^{n}(x_i-\bar{x})^2
L \hat{\mu}=\bar{X}
L \hat{\theta}_{\text{MLE}}=\arg\max_{\theta}L(\theta)
L \ell(\theta)=\sum_{i=1}^{n}\log f(x_i;\theta)
L \frac{\partial\ell}{\partial\theta}=0
L \hat{\lambda}=\frac{n}{\sum_{i=1}^{n}x_i}
L z=\frac{\bar{x}-\mu_0}{\sigma/\sqrt{n}}
L t=\frac{\bar{x}-\mu_0}{s/\sqrt{n}}
L \bar{x}\pm 1.96\frac{\sigma}{\sqrt{n}}
L \chi^2=\sum_{i}\frac{(O_i-E_i)^2}{E_i}
D H_0:\mu=\mu_0\quad H_1:\mu\ne\mu_0
L \hat{\beta}=(X^TX)^{-1}X^Ty
L y=X\beta+\varepsilon
L R^2=1-\frac{SS_{\text{res}}}{SS_{\text{tot}}}
L \operatorname{MSE}(\hat{\theta})=\operatorname{Var}(\hat{\theta})+\operatorname{bias}(\hat{\theta})^2
A \operatorname{Var}(\hat{\theta})\ge\frac{1}{I(\theta)}
L r=\frac{\sum(x_i-\bar{x})(y_i-\bar{y})}{\sqrt{\sum(x_i-\bar{x})^2\sum(y_i-\bar{y})^2}}`,
  },
  topology: {
    'metric and topological spaces': R`
D (X,d)
A d(x,z)\le d(x,y)+d(y,z)
D B_\varepsilon(x)=\{y\in X:d(x,y)<\varepsilon\}
D \mathcal{T}\subseteq\mathcal{P}(X)
A U,V\in\mathcal{T}\implies U\cap V\in\mathcal{T}
A \bigcup_{i\in I}U_i\in\mathcal{T}
D \overline{A}=\bigcap\{F\supseteq A:F\ \text{closed}\}
D A^\circ=\bigcup\{U\subseteq A:U\ \text{open}\}
L \partial A=\overline{A}\setminus A^\circ
L \overline{\mathbb{Q}}=\mathbb{R}
L \partial[0,1)=\{0,1\}
L (0,1)^\circ=(0,1)
A f^{-1}(U)\ \text{open}\ \forall U\ \text{open}
A K\ \text{compact}\iff K\ \text{closed and bounded}
A X=\bigcup_{i=1}^{n}U_{i}
D X\cong Y
D \pi_1(S^1)\cong\mathbb{Z}
D S^n=\{x\in\mathbb{R}^{n+1}:\|x\|=1\}
D \mathbb{R}P^2
A d_\infty(f,g)=\sup_{x\in[0,1]}|f(x)-g(x)|
D X\times Y`,
  },
  measure: {
    'measure and integration': R`
D (\Omega,\mathcal{F},\mu)
D \mathcal{F}\ \text{is a}\ \sigma\text{-algebra}
A A\in\mathcal{F}\implies A^c\in\mathcal{F}
A \mu\left(\bigcup_{n=1}^{\infty}A_n\right)=\sum_{n=1}^{\infty}\mu(A_n)
D \mathcal{B}(\mathbb{R})=\sigma(\{(a,b):a<b\})
L \lambda([a,b])=b-a
L \lambda(\mathbb{Q})=0
D \int_{\Omega}f\,d\mu
L \int_{\mathbb{R}}\mathbf{1}_{[0,1]}\,d\lambda=1
A f_n\to f\ \mu\text{-a.e.}
A \int\liminf_{n\to\infty}f_n\,d\mu\le\liminf_{n\to\infty}\int f_n\,d\mu
A \lim_{n\to\infty}\int f_n\,d\mu=\int f\,d\mu
A |f_n|\le g,\ g\in L^1(\mu)
D L^p(\mu)=\left\{f:\int|f|^p\,d\mu<\infty\right\}
L \|f\|_p=\left(\int|f|^p\,d\mu\right)^{1/p}
A \int|fg|\,d\mu\le\|f\|_p\|g\|_q
A \frac{1}{p}+\frac{1}{q}=1
A \int_{X\times Y}f\,d(\mu\otimes\nu)=\int_X\int_Yf\,d\nu\,d\mu
A \nu\ll\mu
D \frac{d\nu}{d\mu}
A \mu(\{x:|f(x)|>t\})\le\frac{1}{t}\int|f|\,d\mu
D \mathbf{1}_A(x)=\begin{cases}1&x\in A\\0&x\notin A\end{cases}`,
  },
  functional: {
    'normed spaces and operators': R`
D (X,\|\cdot\|)
A \|x+y\|\le\|x\|+\|y\|
A \|\lambda x\|=|\lambda|\|x\|
D \langle x,y\rangle=\overline{\langle y,x\rangle}
L \|x\|^2=\langle x,x\rangle
A \|x+y\|^2+\|x-y\|^2=2\|x\|^2+2\|y\|^2
L \|T\|=\sup_{\|x\|\le 1}\|Tx\|
A \|Tx\|\le\|T\|\|x\|
D T\in\mathcal{B}(X,Y)
D X^*=\mathcal{B}(X,\mathbb{K})
A \langle Tx,y\rangle=\langle x,T^*y\rangle
D \ell^2=\left\{(x_n):\sum_{n=1}^{\infty}|x_n|^2<\infty\right\}
A x=\sum_{n=1}^{\infty}\langle x,e_n\rangle e_n
A \|x\|^2=\sum_{n=1}^{\infty}|\langle x,e_n\rangle|^2
D H=M\oplus M^\perp
A x_n\rightharpoonup x
D \sigma(T)=\{\lambda\in\mathbb{C}:T-\lambda I\ \text{not invertible}\}
A r(T)=\lim_{n\to\infty}\|T^n\|^{1/n}
D C([0,1])
D \iota:X\hookrightarrow X^{**}
D q:X\twoheadrightarrow X/M`,
  },
  numerical: {
    'numerical methods': R`
L x_{n+1}=x_n-\frac{f(x_n)}{f'(x_n)}
L x_1=1-\frac{1-2}{2}=\frac{3}{2}
L |x_{n+1}-x^*|\le C|x_n-x^*|^2
L \int_a^bf(x)\,dx\approx\frac{h}{2}\left[f(x_0)+2\sum_{i=1}^{n-1}f(x_i)+f(x_n)\right]
L \int_a^bf(x)\,dx\approx\frac{b-a}{6}\left[f(a)+4f\left(\frac{a+b}{2}\right)+f(b)\right]
L y_{n+1}=y_n+hf(t_n,y_n)
L k_1=f(t_n,y_n)
L y_{n+1}=y_n+\frac{h}{6}(k_1+2k_2+2k_3+k_4)
L f'(x)\approx\frac{f(x+h)-f(x-h)}{2h}
L f''(x)\approx\frac{f(x+h)-2f(x)+f(x-h)}{h^2}
L A=LU
L \kappa(A)=\|A\|\|A^{-1}\|
L x^{(k+1)}=D^{-1}\left(b-(L+U)x^{(k)}\right)
L p(x)=\sum_{i=0}^{n}y_i\ell_i(x)
L \ell_i(x)=\prod_{j\ne i}\frac{x-x_j}{x_i-x_j}
L \varepsilon_{\text{mach}}=2^{-52}
L E=O(h^2)`,
  },
  diffgeo: {
    'tensors and differential geometry': R`
D g_{\mu\nu}
L g^{\mu\nu}g_{\nu\lambda}=\delta^\mu_\lambda
L v^i=\frac{\partial x^i}{\partial y^j}w^j
L T^{i}{}_{j}=\frac{\partial x^i}{\partial y^k}\frac{\partial y^l}{\partial x^j}T^k{}_l
L \Gamma^k_{ij}=\frac{1}{2}g^{kl}\left(\partial_ig_{jl}+\partial_jg_{il}-\partial_lg_{ij}\right)
D \nabla_\mu V^\nu=\partial_\mu V^\nu+\Gamma^\nu_{\mu\lambda}V^\lambda
D R^\rho{}_{\sigma\mu\nu}
L ds^2=dx^2+dy^2+dz^2
L ds^2=dr^2+r^2d\theta^2
L \kappa=\frac{|\gamma'\times\gamma''|}{|\gamma'|^3}
D \omega=f\,dx\wedge dy
L d(f\,dx)=\frac{\partial f}{\partial y}dy\wedge dx
A \int_Md\omega=\int_{\partial M}\omega
D T_pM
D \epsilon_{ijk}
L (\vec{a}\times\vec{b})_i=\epsilon_{ijk}a_jb_k
L \epsilon_{ijk}\epsilon_{imn}=\delta_{jm}\delta_{kn}-\delta_{jn}\delta_{km}
L K=\frac{LN-M^2}{EG-F^2}
D \mathfrak{X}(M)
L [X,Y]=XY-YX`,
  },
};
