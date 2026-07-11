#include "../../../Assets/Shaders/Shared.hlsl"
float FromPackage(float x) { return SharedRef(x + 2.0); }
