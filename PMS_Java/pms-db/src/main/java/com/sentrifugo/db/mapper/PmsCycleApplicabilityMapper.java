package com.sentrifugo.db.mapper;

import com.sentrifugo.db.dto.PmsCycleApplicabilityDTO;
import com.sentrifugo.db.entity.PmsCycleApplicabilityEntity;
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
public interface PmsCycleApplicabilityMapper {

    // Parent / referenced entities are resolved and attached by the service, never taken from the DTO.
    @Mapping(target = "cycle", ignore = true)
    PmsCycleApplicabilityEntity toEntity(PmsCycleApplicabilityDTO dto);

    @Mapping(source = "cycle.id", target = "cycleId")
    PmsCycleApplicabilityDTO toDTO(PmsCycleApplicabilityEntity entity);

    List<PmsCycleApplicabilityEntity> toEntityList(List<PmsCycleApplicabilityDTO> dtoList);

    List<PmsCycleApplicabilityDTO> toDTOList(List<PmsCycleApplicabilityEntity> entityList);

    @Mapping(target = "id", ignore = true)
    @Mapping(target = "cycle", ignore = true)
    void updateEntityFromDto(PmsCycleApplicabilityDTO dto, @MappingTarget PmsCycleApplicabilityEntity entity);
}
