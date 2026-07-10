Shader "Test/MultiPassDefn" {
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
