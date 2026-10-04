package com.sentrifugo.db.mapper;

import com.sentrifugo.db.dto.PmsRatingScaleDTO;
import com.sentrifugo.db.entity.PmsRatingScaleEntity;
import org.mapstruct.Builder;
import org.mapstruct.Mapper;
import org.mapstruct.Mapping;
import org.mapstruct.MappingTarget;
import org.mapstruct.NullValuePropertyMappingStrategy;
import org.mapstruct.ReportingPolicy;

import java.util.List;

@Mapper(
        componentModel = "spring",
        unmappedTargetPolicy = ReportingPolicy.IGNORE,
        nullValuePropertyMappingStrategy = NullValuePropertyMappingStrategy.IGNORE,
        // Lombok @SuperBuilder entities/DTOs: map through constructor + setters (see PmsCycleMapper).
        builder = @Builder(disableBuilder = true)
)
public interface PmsRatingScaleMapper {

    // Parent / referenced entities are resolved and attached by the service, never taken from the DTO.
    PmsRatingScaleEntity toEntity(PmsRatingScaleDTO dto);

    PmsRatingScaleDTO toDTO(PmsRatingScaleEntity entity);

    List<PmsRatingScaleEntity> toEntityList(List<PmsRatingScaleDTO> dtoList);

    List<PmsRatingScaleDTO> toDTOList(List<PmsRatingScaleEntity> entityList);

    @Mapping(target = "id", ignore = true)
    void updateEntityFromDto(PmsRatingScaleDTO dto, @MappingTarget PmsRatingScaleEntity entity);
}
