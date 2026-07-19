Shader "Test/MultiPassDefn" {
  Properties {
    _Tint ("Tint", Color) = (1, 1, 1, 1)
  }
  SubShader {
    Pass {
      Name "ForwardLit"
      HLSLPROGRAM
      void vert() {}
      void main_forward() { vert(); }
      ENDHLSL
    }
    Pass {
      Name "ShadowCaster"
      HLSLPROGRAM
      void vert() {}
      void main_shadow() { vert(); }
      ENDHLSL
    }
  }
}
